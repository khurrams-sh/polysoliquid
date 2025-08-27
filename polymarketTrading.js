const axios = require('axios');
const { ClobClient, OrderType, Side } = require('@polymarket/clob-client');
const { Wallet } = require('ethers');

class PolymarketTrading {
  constructor(privyClient) {
    this.privy = privyClient;
    this.apiUrl = 'https://gamma-api.polymarket.com';
    this.ctfApiUrl = 'https://ctf-api.polymarket.com';
    this.dataApiUrl = 'https://data-api.polymarket.com';
    this.clobHost = 'https://clob.polymarket.com';
    this.chainId = 137; // Polygon chain ID
    this.clients = new Map(); // Cache CLOB clients by wallet address
  }

  async executeTrade(walletId, action, amount, asset, chatId, bot) {
    try {
      bot.sendMessage(chatId, `🔄 Processing Polymarket ${action} ${amount} shares in "${asset}"...`);

      // Get wallet for signing
      const wallet = await this.privy.walletApi.getWallet(walletId);
      const walletAddress = wallet.address;

      // Get market data using market question/title
      const marketData = await this.findMarketByQuestion(asset);

      if (!marketData) {
        bot.sendMessage(chatId, `❌ Market not found: "${asset}". Use /markets to see available markets.`);
        return;
      }

      // Check if market is active
      if (marketData.closed) {
        bot.sendMessage(chatId, '❌ This market is closed and no longer accepting trades.');
        return;
      }

      // Export private key for CLOB client
      const privateKey = await this.exportWalletPrivateKey(walletId);

      if (!privateKey) {
        bot.sendMessage(chatId, '❌ Failed to access wallet private key. Please try again.');
        return;
      }

      // Execute the real trade using CLOB API
      const result = await this.placeOrder(walletId, action, amount, marketData, privateKey);

      if (result && result.success) {
        bot.sendMessage(chatId,
          `✅ **Polymarket Trade Executed!**\n\n` +
          `📊 **Market:** ${marketData.question}\n` +
          `🔄 **Action:** ${action.toUpperCase()} ${amount} shares\n` +
          `💰 **Price:** $${(result.executedPrice / 100).toFixed(4)}\n` +
          `📈 **Outcome:** ${action === 'buy' ? marketData.outcomes[0] : marketData.outcomes[1]}\n` +
          `🔗 **Order ID:** ${result.orderId}\n` +
          `⚡ **Status:** Filled\n\n` +
          `💡 **Note:** Real Polymarket CLOB trade executed successfully!`
        );
      } else {
        bot.sendMessage(chatId, `❌ Trade failed: ${result?.error || 'Unknown error occurred'}`);
      }

    } catch (error) {
      console.error('Error executing Polymarket trade:', error);
      bot.sendMessage(chatId, `❌ Error: ${error.message}`);
    }
  }

  async findMarketByQuestion(question) {
    try {
      const response = await axios.get(`${this.apiUrl}/markets`, {
        params: {
          closed: false,
          active: true,
          limit: 50
        },
        timeout: 5000
      });

      if (response.data && Array.isArray(response.data)) {
        // Find market by question/title (case-insensitive partial match)
        const market = response.data.find(m =>
          m.question.toLowerCase().includes(question.toLowerCase()) ||
          question.toLowerCase().includes(m.question.toLowerCase())
        );

        if (market) {
          return {
            id: market.id,
            question: market.question,
            outcomes: market.outcomes || ['Yes', 'No'],
            closed: market.closed || false,
            price: Math.round((market.outcomes?.[0]?.price || 0.5) * 10000), // Convert to cents
            volume: market.volume || '0',
            endDate: market.endDate
          };
        }
      }

      return null;
    } catch (error) {
      console.error('Error finding market:', error);
      return null;
    }
  }

  async placeOrder(walletId, action, amount, marketData, privateKey) {
    try {
      // Get wallet for address
      const wallet = await this.privy.walletApi.getWallet(walletId);
      const walletAddress = wallet.address;

      // Create ethers signer from private key
      const signer = new Wallet(privateKey);

      // Get or create CLOB client
      const clobClient = await this.getClobClient(privateKey, walletAddress);

      // Get token ID from market data
      const tokenId = await this.getTokenId(marketData, action);

      if (!tokenId) {
        throw new Error('Could not find valid token ID for this market outcome');
      }

      // Determine side
      const side = action === 'buy' ? Side.BUY : Side.SELL;

      // Calculate price (Polymarket uses decimals, not cents for orders)
      const price = (marketData.price / 10000).toFixed(6);

      console.log('Placing Polymarket order:', {
        tokenId,
        side,
        price,
        amount,
        market: marketData.question
      });

      // Place the order using CLOB API
      const orderResponse = await clobClient.createAndPostOrder(
        {
          tokenID: tokenId,
          price: parseFloat(price),
          side: side,
          size: parseFloat(amount),
          feeRateBps: 0,
        },
        {
          tickSize: "0.001",
          negRisk: marketData.negRisk || false
        },
        OrderType.GTC
      );

      if (orderResponse && orderResponse.success !== false) {
        return {
          success: true,
          orderId: orderResponse.orderId || orderResponse.data?.order_id || orderResponse.id,
          executedPrice: marketData.price,
          executedAmount: amount,
          outcome: action === 'buy' ? marketData.outcomes[0] : marketData.outcomes[1],
          marketId: marketData.id
        };
      } else {
        throw new Error(orderResponse?.error || 'Order placement failed');
      }

    } catch (error) {
      console.error('Error placing CLOB order:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async getClobClient(privateKey, walletAddress) {
    // Check if we already have a client for this wallet
    if (this.clients.has(walletAddress)) {
      return this.clients.get(walletAddress);
    }

    try {
      // Create signer from private key
      const signer = new Wallet(privateKey);

      // Initialize CLOB client
      const clobClient = new ClobClient(this.clobHost, this.chainId, signer);

      // Create or derive API credentials
      const creds = await clobClient.createOrDeriveApiKey();

      // Create authenticated client
      const authenticatedClient = new ClobClient(this.clobHost, this.chainId, signer, creds);

      // Cache the client
      this.clients.set(walletAddress, authenticatedClient);

      return authenticatedClient;
    } catch (error) {
      console.error('Error creating CLOB client:', error);
      throw new Error(`Failed to initialize Polymarket client: ${error.message}`);
    }
  }

  async getTokenId(marketData, action) {
    try {
      // Get detailed market information to find token IDs
      const marketDetails = await this.getMarketDetails(marketData.id);

      if (!marketDetails || !marketDetails.outcomes) {
        return null;
      }

      // Find the token ID for the selected outcome
      const outcome = action === 'buy' ? marketData.outcomes[0] : marketData.outcomes[1];

      for (let i = 0; i < marketDetails.outcomes.length; i++) {
        if (marketDetails.outcomes[i] === outcome) {
          // Return the token ID for this outcome
          return marketDetails.tokens ? marketDetails.tokens[i] : null;
        }
      }

      return null;
    } catch (error) {
      console.error('Error getting token ID:', error);
      return null;
    }
  }

  async exportWalletPrivateKey(walletId) {
    const { CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } = require('@hpke/core');
    const { Chacha20Poly1305 } = require('@hpke/chacha20poly1305');

    try {
      // Generate ephemeral keypair for HPKE
      const keypair = await crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" },
        true,
        ["deriveKey", "deriveBits"]
      );

      const [publicKey, privateKey] = await Promise.all([
        crypto.subtle.exportKey("spki", keypair.publicKey),
        crypto.subtle.exportKey("pkcs8", keypair.privateKey)
      ]);

      const [publicKeyBase64, privateKeyBase64] = [
        Buffer.from(publicKey).toString("base64"),
        Buffer.from(privateKey).toString("base64")
      ];

      const input = {
        headers: {
          "privy-app-id": process.env.PRIVY_APP_ID,
        },
        method: "POST",
        url: `https://api.privy.io/v1/wallets/${walletId}/export`,
        version: 1,
        body: {
          encryption_type: "HPKE",
          recipient_public_key: publicKeyBase64,
        },
      };

      const signature = this.privy.walletApi.generateAuthorizationSignature({
        input: input,
        authorizationPrivateKey: process.env.PRIVY_AUTH_KEY_PRIVATE
      });

      const response = await axios.post(
        `https://api.privy.io/v1/wallets/${walletId}/export`,
        input.body,
        {
          headers: {
            ...input.headers,
            "Content-Type": "application/json",
            "privy-authorization-signature": signature,
            "Authorization": `Basic ${Buffer.from(`${process.env.PRIVY_APP_ID}:${process.env.PRIVY_APP_SECRET}`).toString('base64')}`,
          },
        }
      );

      if (response.data && response.data.ciphertext && response.data.encapsulated_key) {
        const cipherSuite = new CipherSuite({
          kem: new DhkemP256HkdfSha256(),
          kdf: new HkdfSha256(),
          aead: new Chacha20Poly1305()
        });

        const base64ToBuffer = (base64) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)).buffer;

        const recipientKey = await crypto.subtle.importKey(
          'pkcs8',
          base64ToBuffer(privateKeyBase64),
          { name: 'ECDH', namedCurve: 'P-256' },
          true,
          ['deriveKey', 'deriveBits']
        );

        const recipient = await cipherSuite.createRecipientContext({
          recipientKey: recipientKey,
          enc: base64ToBuffer(response.data.encapsulated_key)
        });

        const decryptedPrivateKey = new TextDecoder().decode(
          await recipient.open(base64ToBuffer(response.data.ciphertext))
        );

        return decryptedPrivateKey;
      } else {
        throw new Error('Invalid response from Privy API');
      }

    } catch (error) {
      console.error('Error exporting wallet:', error);
      throw new Error(`Failed to export wallet: ${error.message}`);
    }
  }



  async getPositions(walletId) {
    try {
      const wallet = await this.privy.walletApi.getWallet(walletId);
      const walletAddress = wallet.address;

      // Get positions using Polymarket Data API
      const response = await axios.get(`${this.dataApiUrl}/positions`, {
        params: {
          user: walletAddress.toLowerCase(),
          limit: 20,
          active: true
        },
        timeout: 5000
      });

      if (response.data && Array.isArray(response.data)) {
        const positions = response.data.map(pos => ({
          marketId: pos.market,
          marketQuestion: pos.title || 'Unknown Market',
          outcome: pos.outcome,
          shares: parseFloat(pos.size),
          avgPrice: parseFloat(pos.avgPrice || 0),
          currentPrice: parseFloat(pos.curPrice || 0),
          value: parseFloat(pos.size) * parseFloat(pos.curPrice || 0),
          pnl: parseFloat(pos.pnl || 0),
          pnlPercent: parseFloat(pos.pnlPercent || 0)
        }));

        const totalValue = positions.reduce((sum, pos) => sum + pos.value, 0);

        return {
          positions: positions,
          wallet: walletAddress,
          totalValue: totalValue,
          count: positions.length
        };
      }

      return {
        positions: [],
        wallet: walletAddress,
        totalValue: 0,
        count: 0
      };

    } catch (error) {
      console.error('Error getting Polymarket positions:', error);
      return {
        positions: [],
        wallet: null,
        totalValue: 0,
        count: 0,
        note: 'Unable to fetch positions at this time'
      };
    }
  }

  async getBalance(walletId) {
    try {
      const positions = await this.getPositions(walletId);
      return positions.totalValue || 0;
    } catch (error) {
      console.error('Error getting Polymarket balance:', error);
      return 0;
    }
  }

  async getMarkets(limit = 10) {
    try {
      const response = await axios.get(`${this.apiUrl}/markets`, {
        params: {
          closed: false,
          active: true,
          limit: limit
        },
        timeout: 5000
      });

      // Transform real Polymarket API response
      if (response.data && Array.isArray(response.data)) {
        return response.data.map(market => {
          // Parse outcomes from JSON string if needed
          let outcomes = ['Yes', 'No']; // default
          if (market.outcomes) {
            try {
              outcomes = typeof market.outcomes === 'string'
                ? JSON.parse(market.outcomes)
                : market.outcomes;
            } catch (e) {
              console.warn('Failed to parse market outcomes:', market.outcomes);
            }
          }

          return {
            id: market.id,
            question: market.question || 'Unknown Question',
            price: Math.round((market.outcomes?.[0]?.price || 0.5) * 10000), // Convert to cents
            volume: market.volume || '0',
            outcomes: outcomes,
            closed: market.closed || false,
            endDate: market.endDate,
            category: market.category || 'General'
          };
        });
      }

      return [];
    } catch (error) {
      console.error('Error getting Polymarket markets:', error.message);
      // Return empty array instead of mock data
      return [];
    }
  }

  async getMarketDetails(marketId) {
    try {
      const response = await axios.get(`${this.apiUrl}/markets/${marketId}`);

      if (response.data) {
        // Parse outcomes from JSON string if needed
        let outcomes = ['Yes', 'No']; // default
        if (response.data.outcomes) {
          try {
            outcomes = typeof response.data.outcomes === 'string'
              ? JSON.parse(response.data.outcomes)
              : response.data.outcomes;
          } catch (e) {
            console.warn('Failed to parse market outcomes:', response.data.outcomes);
          }
        }

        return {
          id: response.data.id,
          question: response.data.question,
          description: response.data.description,
          outcomes: outcomes,
          tokens: response.data.tokens || [], // Token IDs for each outcome
          prices: outcomes.map((_, i) => response.data.prices?.[i] || 0.5) || [0.5, 0.5],
          volume: response.data.volume || '0',
          closed: response.data.closed || false,
          endDate: response.data.endDate,
          category: response.data.category || 'General',
          negRisk: response.data.negRisk || false
        };
      }

      return null;
    } catch (error) {
      console.error('Error getting market details:', error);
      return null;
    }
  }
}

module.exports = PolymarketTrading;
