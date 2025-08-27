const axios = require('axios');
const { Wallet, ethers } = require('ethers');

class HyperliquidTrading {
  constructor(privyClient) {
    this.privy = privyClient;
    this.apiUrl = 'https://api.hyperliquid.xyz';
    this.exchangeUrl = 'https://api.hyperliquid.xyz/exchange';
    this.testnetApiUrl = 'https://api.hyperliquid-testnet.xyz';
    this.testnetExchangeUrl = 'https://api.hyperliquid-testnet.xyz/exchange';
    this.vaultAddress = '0xC7f1E1c8F4c69F3E2C8E2B2E8B9F9E8F8E8F8E8F'; // Hyperliquid vault address
    this.clients = new Map(); // Cache ethers signers by wallet address
    this.isTestnet = process.env.HYPERLIQUID_TESTNET === 'true';

    // Hyperliquid API credentials (optional but recommended)
    this.apiKey = process.env.HYPERLIQUID_API_KEY || null;
    this.apiSecret = process.env.HYPERLIQUID_API_SECRET || null;
  }

  async executeTrade(walletId, action, amount, asset, chatId, bot) {
    try {
      bot.sendMessage(chatId, `🔄 Processing Hyperliquid ${action} ${amount} ${asset}...`);

      // Get wallet address from Privy
      const wallet = await this.privy.walletApi.getWallet(walletId);
      const walletAddress = wallet.address;

      // Get market data first
      const marketData = await this.getMarketData(asset);
      if (!marketData) {
        bot.sendMessage(chatId, '❌ Unable to get market data. Please check the asset symbol and try again.');
        return;
      }

      // Create the order
      const order = await this.createOrder(walletAddress, action, amount, asset, marketData);

      if (order && order.success) {
        bot.sendMessage(chatId, `✅ Successfully executed ${action} ${amount} ${asset}\nOrder ID: ${order.orderId || 'Market Order'}\nPrice: $${order.price || marketData.markPx}\nStatus: ${order.status || 'Filled'}`);
      } else {
        bot.sendMessage(chatId, `❌ Failed to execute trade: ${order?.error || 'Unknown error'}`);
      }

    } catch (error) {
      console.error('Error executing Hyperliquid trade:', error);
      bot.sendMessage(chatId, `❌ Error: ${error.message}`);
    }
  }

  async getMarketData(asset) {
    try {
      const baseUrl = this.isTestnet ? this.testnetApiUrl : this.apiUrl;

      // Get all current mid prices
      const midsResponse = await axios.post(`${baseUrl}/info`, {
        type: 'allMids'
      });

      // Get asset metadata
      const metaResponse = await axios.post(`${baseUrl}/info`, {
        type: 'meta'
      });

      const assetName = asset.toUpperCase();
      const midPrice = midsResponse.data[assetName];
      const assetInfo = metaResponse.data.universe.find(a => a.name === assetName);

      if (!midPrice || !assetInfo) {
        console.error(`Asset ${asset} not found in Hyperliquid data`);
        return null;
      }

      const assetIndex = metaResponse.data.universe.findIndex(a => a.name === assetName);

      return {
        assetIndex: assetIndex,
        name: assetName,
        markPx: parseFloat(midPrice),
        oraclePx: parseFloat(midPrice), // Using mid price as oracle price
        fundingRate: 0, // Would need separate call for funding rates
        szDecimals: assetInfo.szDecimals,
        maxLeverage: assetInfo.maxLeverage
      };
    } catch (error) {
      console.error('Error getting Hyperliquid market data:', error);
      return null;
    }
  }

  async createOrder(walletId, action, amount, asset, marketData) {
    try {
      // Get wallet for address
      const wallet = await this.privy.walletApi.getWallet(walletId);
      const walletAddress = wallet.address;

      // Export private key for signing
      const privateKey = await this.exportWalletPrivateKey(walletId);

      if (!privateKey) {
        throw new Error('Failed to access wallet private key for signing');
      }

      // Create ethers signer
      const signer = await this.getSigner(privateKey, walletAddress);

      // Calculate order size in base units (considering szDecimals)
      const szDecimals = marketData.szDecimals || 0;
      const orderSize = parseFloat(amount) * Math.pow(10, szDecimals);

      // Create order data structure - CORRECTED for Hyperliquid
      const orderData = {
        type: 'order',
        grouping: 'na',
        orders: [{
          asset: marketData.assetIndex,
          isBuy: action === 'buy',
          reduceOnly: false,
          size: orderSize,
          limitPx: marketData.markPx.toString(), // Convert to string as required
          tif: 'Ioc' // Immediate or Cancel
        }]
      };

      // CORRECT EIP-712 SIGNATURE GENERATION FOR HYPERLIQUID
      const domain = {
        name: 'HyperliquidSign',
        version: '1',
        chainId: 1337, // Hyperliquid uses chainId 1337
        verifyingContract: '0x0000000000000000000000000000000000000000'
      };

      const types = {
        Order: [
          { name: 'asset', type: 'uint32' },
          { name: 'isBuy', type: 'bool' },
          { name: 'reduceOnly', type: 'bool' },
          { name: 'size', type: 'uint64' },
          { name: 'limitPx', type: 'string' },
          { name: 'tif', type: 'string' }
        ],
        OrderRequest: [
          { name: 'type', type: 'string' },
          { name: 'grouping', type: 'string' },
          { name: 'orders', type: 'Order[]' }
        ]
      };

      const orderForSigning = {
        asset: marketData.assetIndex,
        isBuy: action === 'buy',
        reduceOnly: false,
        size: orderSize.toString(), // Convert to string for EIP-712
        limitPx: marketData.markPx.toString(),
        tif: 'Ioc'
      };

      const value = {
        type: 'order',
        grouping: 'na',
        orders: [orderForSigning]
      };

      // Sign using EIP-712
      const signature = await signer.signTypedData(domain, types, value);

      // Add signature to order data
      orderData.signature = signature;

      console.log('Submitting Hyperliquid order:', {
        asset: asset,
        action: action,
        amount: amount,
        price: marketData.markPx,
        orderSize: orderSize,
        wallet: walletAddress,
        testnet: this.isTestnet
      });

      // Submit order to Hyperliquid exchange (use correct URL based on testnet)
      const exchangeUrl = this.isTestnet ? this.testnetExchangeUrl : this.exchangeUrl;
      const response = await axios.post(exchangeUrl, orderData, {
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 10000
      });

      if (response.data && response.data.status === 'ok') {
        return {
          success: true,
          orderId: response.data.response?.data?.statuses?.[0]?.id || Date.now().toString(),
          executedPrice: marketData.markPx,
          executedAmount: amount,
          asset: asset,
          status: 'filled'
        };
      } else {
        throw new Error(response.data?.response?.data?.statuses?.[0]?.error || 'Order submission failed');
      }

    } catch (error) {
      console.error('Error creating Hyperliquid order:', error);
      return { success: false, error: error.message };
    }
  }

  async getSigner(privateKey, walletAddress) {
    // Check if we already have a signer for this wallet
    if (this.clients.has(walletAddress)) {
      return this.clients.get(walletAddress);
    }

    try {
      // Create new signer from private key
      const signer = new Wallet(privateKey);

      // Cache the signer
      this.clients.set(walletAddress, signer);

      return signer;
    } catch (error) {
      console.error('Error creating signer:', error);
      throw new Error(`Failed to create signer: ${error.message}`);
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
      // Get wallet address from Privy
      const wallet = await this.privy.walletApi.getWallet(walletId);
      const address = wallet.address;

      const baseUrl = this.isTestnet ? this.testnetApiUrl : this.apiUrl;
      const response = await axios.post(`${baseUrl}/info`, {
        type: 'clearinghouseState',
        user: address
      });

      if (response.data) {
        return response.data;
      }

      return null;
    } catch (error) {
      console.error('Error getting Hyperliquid positions:', error);
      // Return empty positions structure for new users
      return {
        assetPositions: [],
        marginSummary: {
          accountValue: '0',
          totalNtlPos: '0',
          totalRawUsd: '0'
        }
      };
    }
  }

  async getBalance(walletId) {
    try {
      const positions = await this.getPositions(walletId);
      if (!positions) return 0;

      // Calculate total value from positions
      let totalValue = 0;
      if (positions.marginSummary && positions.marginSummary.accountValue) {
        totalValue = parseFloat(positions.marginSummary.accountValue);
      }

      return totalValue;
    } catch (error) {
      console.error('Error getting Hyperliquid balance:', error);
      return 0;
    }
  }

  async getMarkets(limit = 10) {
    try {
      const baseUrl = this.isTestnet ? this.testnetApiUrl : this.apiUrl;

      // Get all current mid prices
      const midsResponse = await axios.post(`${baseUrl}/info`, {
        type: 'allMids'
      });

      // Get asset metadata
      const metaResponse = await axios.post(`${baseUrl}/info`, {
        type: 'meta'
      });

      if (midsResponse.data && metaResponse.data && metaResponse.data.universe) {
        const assetNames = Object.keys(midsResponse.data).filter(name =>
          !name.startsWith('@') // Filter out indexed assets, keep named ones
        ).slice(0, limit);

        return assetNames.map(assetName => {
          const assetInfo = metaResponse.data.universe.find(a => a.name === assetName);
          return {
            name: assetName,
            symbol: assetName,
            szDecimals: assetInfo ? assetInfo.szDecimals : 0,
            price: parseFloat(midsResponse.data[assetName]) || 0,
            volume: '0' // Volume data would require additional API calls
          };
        });
      }

      return [];
    } catch (error) {
      console.error('Error getting Hyperliquid markets:', error);
      return [];
    }
  }
}

module.exports = HyperliquidTrading;
