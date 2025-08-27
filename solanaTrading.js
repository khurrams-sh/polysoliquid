const axios = require('axios');
const { Connection, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');

class SolanaTrading {
  constructor(privyClient) {
    this.privy = privyClient;
    this.jupiterUltraUrl = 'https://lite-api.jup.ag/ultra/v1';
    this.jupiterUltraExecuteUrl = 'https://api.jup.ag/ultra/v1';
    this.connection = new Connection('https://api.mainnet.solana.com');

    // Jupiter Ultra API requires API key for some endpoints
    this.apiKey = process.env.JUPITER_API_KEY || null;
  }

  async executeTrade(walletId, action, amount, asset, chatId, bot) {
    try {
      bot.sendMessage(chatId, `🔄 Processing Solana ${action} ${amount} ${asset}...`);

      // Get wallet address for taker parameter
      const walletAddress = await this.getWalletPublicKey(walletId);

      // Get order from Jupiter Ultra API
      const order = await this.getUltraOrder(asset, amount, action, walletAddress);

      if (!order || !order.transaction) {
        bot.sendMessage(chatId, '❌ Unable to get order. Please check the asset symbol and try again.');
        return;
      }

      // Execute the order using Jupiter Ultra API
      const result = await this.executeUltraOrder(order, walletId);

      if (result) {
        const inAmount = parseFloat(order.inAmount) / (action === 'buy' ? 1000000 : LAMPORTS_PER_SOL);
        const outAmount = parseFloat(order.outAmount) / (action === 'buy' ? LAMPORTS_PER_SOL : 1000000);

        bot.sendMessage(chatId, `✅ **Successfully executed ${action} ${amount} ${asset}**\n\n📊 **Trade Details:**\n• Input: ${inAmount.toFixed(6)} ${action === 'buy' ? 'USDC' : 'SOL'}\n• Output: ${outAmount.toFixed(6)} ${action === 'buy' ? 'SOL' : 'USDC'}\n• Price Impact: ${order.priceImpactPct}%\n• Fee: ${(parseFloat(order.feeBps) / 100).toFixed(2)}%\n\n🔗 **Tx:** https://solscan.io/tx/${result.txHash}`);
      } else {
        bot.sendMessage(chatId, '❌ Failed to execute trade. Please try again.');
      }

    } catch (error) {
      console.error('Error executing Solana trade:', error);
      bot.sendMessage(chatId, `❌ **Trade Error:** ${error.message}`);
    }
  }

  async getUltraOrder(asset, amount, action, takerAddress) {
    try {
      // Map common assets to token mints
      const tokenMap = {
        'SOL': 'So11111111111111111111111111111111111111112',
        'USDC': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        'USDT': 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
      };

      const inputMint = action === 'buy' ? tokenMap['USDC'] : tokenMap['SOL'];
      const outputMint = action === 'buy' ? tokenMap['SOL'] : tokenMap['USDC'];

      if (!inputMint || !outputMint) {
        throw new Error('Unsupported asset. Supported: SOL, USDC, USDT');
      }

      const amountInLamports = action === 'buy'
        ? Math.floor(parseFloat(amount) * 1000000) // USDC has 6 decimals
        : Math.floor(parseFloat(amount) * LAMPORTS_PER_SOL); // SOL has 9 decimals

      const params = new URLSearchParams({
        inputMint,
        outputMint,
        amount: amountInLamports.toString(),
        taker: takerAddress,
        slippageBps: '50' // 0.5% slippage
      });

      const headers = {};
      if (this.apiKey) {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      }

      const response = await axios.get(`${this.jupiterUltraUrl}/order?${params}`, {
        headers,
        timeout: 10000
      });

      return response.data;
    } catch (error) {
      console.error('Error getting Jupiter Ultra order:', error);
      throw new Error(`Failed to get order: ${error.response?.data?.message || error.message}`);
    }
  }

  async executeUltraOrder(order, walletId) {
    try {
      if (!order.requestId) {
        throw new Error('No request ID in order response');
      }

      // Execute the order using Jupiter Ultra API
      const executeData = {
        requestId: order.requestId
      };

      const headers = {};
      if (this.apiKey) {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      }

      const executeResponse = await axios.post(`${this.jupiterUltraExecuteUrl}/execute`, executeData, {
        headers,
        timeout: 30000
      });

      if (!executeResponse.data || !executeResponse.data.transaction) {
        throw new Error('No transaction in execute response');
      }

      // Execute the transaction using Privy
      const result = await this.privy.walletApi.solana.sendTransaction({
        walletId,
        transaction: executeResponse.data.transaction,
        chainType: 'solana',
      });

      return result;
    } catch (error) {
      console.error('Error executing Ultra order:', error);
      throw new Error(`Failed to execute order: ${error.response?.data?.message || error.message}`);
    }
  }

  async searchToken(query) {
    try {
      // Use Jupiter Token API V2 for comprehensive search
      const searchParams = new URLSearchParams({
        query: query,
        limit: '10'
      });

      const response = await axios.get(`https://lite-api.jup.ag/tokens/v2/search?${searchParams}`, {
        timeout: 5000
      });

      if (!response.data || !Array.isArray(response.data)) {
        throw new Error('Invalid response from Jupiter Token API V2');
      }

      return {
        tokens: response.data,
        source: 'jupiter-token-api-v2'
      };

    } catch (error) {
      console.error('Error searching tokens with API V2:', error);

      // Fallback to old token list if V2 fails
      try {
        const tokenListResponse = await axios.get('https://token.jup.ag/strict', {
          timeout: 5000
        });

        if (!tokenListResponse.data || !Array.isArray(tokenListResponse.data)) {
          throw new Error('Invalid response from Jupiter Token API');
        }

        // Filter tokens that match the query (case insensitive)
        const matchingTokens = tokenListResponse.data.filter(token => {
          const searchLower = query.toLowerCase();
          return token.symbol?.toLowerCase().includes(searchLower) ||
                 token.name?.toLowerCase().includes(searchLower) ||
                 token.address?.toLowerCase().includes(searchLower);
        }).slice(0, 10);

        return {
          tokens: matchingTokens,
          source: 'jupiter-main-list-fallback'
        };
      } catch (fallbackError) {
        return {
          tokens: [],
          error: `Both APIs failed: ${error.message}`,
          source: 'error'
        };
      }
    }
  }

  async getUltraBalances(walletAddress) {
    try {
      const params = new URLSearchParams({
        wallet: walletAddress
      });

      const headers = {};
      if (this.apiKey) {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      }

      const response = await axios.get(`${this.jupiterUltraUrl}/balances?${params}`, {
        headers,
        timeout: 5000
      });

      return response.data;
    } catch (error) {
      console.error('Error getting Ultra balances:', error);
      return null; the 
    }
  }

  async getWalletPublicKey(walletId) {
    try {
      const wallet = await this.privy.walletApi.getWallet(walletId);
      return wallet.address;
    } catch (error) {
      console.error('Error getting wallet public key:', error);
      throw error;
    }
  }

  async getBalance(walletId) {
    try {
      const publicKey = await this.getWalletPublicKey(walletId);
      const balance = await this.connection.getBalance(new PublicKey(publicKey));
      return balance / LAMPORTS_PER_SOL;
    } catch (error) {
      console.error('Error getting Solana balance:', error);
      return 0;
    }
  }

  async validateTokenAddress(tokenAddress) {
    try {
      // First try Jupiter Token API V2 for comprehensive token data
      const searchParams = new URLSearchParams({
        query: tokenAddress,
        limit: '1'
      });

      try {
        const response = await axios.get(`https://lite-api.jup.ag/tokens/v2/search?${searchParams}`, {
          timeout: 5000
        });

        if (response.data && Array.isArray(response.data) && response.data.length > 0) {
          const token = response.data[0];
          return {
            valid: true,
            token: {
              address: token.id,
              name: token.name,
              symbol: token.symbol,
              decimals: token.decimals,
              tags: token.tags,
              daily_volume: token.stats24h?.volumeChange?.toString(),
              price: token.usdPrice,
              mcap: token.mcap,
              liquidity: token.liquidity,
              isVerified: token.isVerified
            },
            tradable: true,
            source: 'jupiter-token-api-v2'
          };
        }
      } catch (apiV2Error) {
        console.log('Token API V2 failed, falling back to old list');
      }

      // Fallback: Check if token exists in Jupiter's old list
      const tokenListResponse = await axios.get('https://token.jup.ag/strict', {
        timeout: 5000
      });

      if (!tokenListResponse.data || !Array.isArray(tokenListResponse.data)) {
        return { valid: false, error: 'Cannot fetch Jupiter token list' };
      }

      const token = tokenListResponse.data.find(t => t.address === tokenAddress);

      if (token) {
        return {
          valid: true,
          token: token,
          tradable: true,
          source: 'jupiter-list-fallback'
        };
      }

      // Token not in Jupiter list - check if it's a valid Solana token
      try {
        const tokenInfo = await this.connection.getTokenSupply(new PublicKey(tokenAddress));
        return {
          valid: true,
          token: {
            address: tokenAddress,
            name: 'Unknown Token',
            symbol: 'UNKNOWN',
            decimals: tokenInfo.value.decimals || 0
          },
          tradable: false,
          source: 'solana-rpc-only',
          supply: tokenInfo.value.uiAmountString
        };
      } catch (rpcError) {
        return { valid: false, error: 'Invalid token address or not found on Solana' };
      }

    } catch (error) {
      console.error('Error validating token:', error);
      return { valid: false, error: error.message };
    }
  }
}

module.exports = SolanaTrading;
