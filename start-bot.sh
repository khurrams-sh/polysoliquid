#!/bin/bash

echo "🚀 Starting Telegram Trading Bot..."
echo "🌐 Working Directory: $(pwd)"
echo ""

# Check if .env file exists
if [ ! -f ".env" ]; then
    echo "⚠️  .env file not found!"
    echo "   Please copy .env.example to .env and fill in your credentials:"
    echo "   cp .env.example .env"
    echo ""
    exit 1
fi

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    npm install
fi

# Start the bot
echo "🤖 Starting bot..."
npm start
