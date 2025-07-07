#!/bin/bash
set -e  # exit on error

MAIN_BRANCH=main
BUILD_DIR=_site
DEPLOY_BRANCH=gh-pages

echo "🔁 Switching to $DEPLOY_BRANCH branch..."
git checkout $DEPLOY_BRANCH || git checkout -b $DEPLOY_BRANCH

echo "🧹 Cleaning old files..."
git rm -rf . > /dev/null 2>&1 || true
rm -rf *

echo "🔙 Checking out build config from $MAIN_BRANCH..."
git checkout $MAIN_BRANCH -- package.json package-lock.json

echo "📦 Installing dependencies..."
npm install

echo "🔨 Building site..."
npm run build

echo "📋 Copying built files to root of $DEPLOY_BRANCH..."
cp -r $BUILD_DIR/* .

echo "📤 Committing and pushing to $DEPLOY_BRANCH..."
git add .
git commit -m "Deploy site on $(date)"
git push origin $DEPLOY_BRANCH

echo "🔁 Switching back to $MAIN_BRANCH..."
git checkout $MAIN_BRANCH

echo "✅ Deploy complete!"