#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Bonanza CRM — One-time server bootstrap for Ubuntu on AWS EC2
#
# Run this ONCE on a fresh instance:
#   chmod +x setup-server.sh && sudo ./setup-server.sh
#
# After this script completes:
#   1. Fill in /opt/bonanza/server/.env with real values
#   2. Run Certbot (command printed at the end)
#   3. docker compose up -d
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

DEPLOY_DIR="/www/wwwroot/labs.tinyepic.in"
DOMAIN="labs.tinyepic.in"
GITHUB_USER="thakurritesh275"

echo "──────────────────────────────────────────"
echo " Bonanza CRM — UAT Server Bootstrap"
echo "──────────────────────────────────────────"

# ── 1. System updates ─────────────────────────────────────────────────────────
echo "[1/7] Updating system packages..."
apt-get update -qq && apt-get upgrade -y -qq

# ── 2. Install Docker ────────────────────────────────────────────────────────
echo "[2/7] Installing Docker..."
apt-get install -y -qq ca-certificates curl gnupg lsb-release

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \
  gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
  > /etc/apt/sources.list.d/docker.list

apt-get update -qq
apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin

systemctl enable docker
systemctl start docker

echo "[2/7] Docker $(docker --version) installed ✓"

# ── 3. Install Certbot ───────────────────────────────────────────────────────
echo "[3/7] Installing Certbot..."
apt-get install -y -qq certbot
echo "[3/7] Certbot installed ✓"

# ── 4. Create deploy directory ───────────────────────────────────────────────
echo "[4/7] Creating ${DEPLOY_DIR}..."
# BT Panel already creates this directory, but we ensure subdirs exist
mkdir -p "${DEPLOY_DIR}/server"

# ── 5. Copy config files ─────────────────────────────────────────────────────
echo "[5/7] Copying docker-compose.yml..."
# These should be present in the same directory as this script.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cp "${SCRIPT_DIR}/../docker-compose.yml" "${DEPLOY_DIR}/docker-compose.yml"
# Note: nginx is managed by BT Panel — see nginx/nginx.conf for the
# location-block snippet to paste into the BT Panel site config.

# ── 6. Log Docker into GHCR ──────────────────────────────────────────────────
echo "[6/7] Setting up GHCR authentication..."
echo "You will need a GitHub Personal Access Token with 'read:packages' scope."
echo "Create one at: https://github.com/settings/tokens"
echo ""
read -rsp "Paste your GitHub PAT (input hidden): " GH_PAT
echo ""
echo "${GH_PAT}" | docker login ghcr.io -u "${GITHUB_USER}" --password-stdin
echo "[6/7] GHCR login saved ✓"

# ── 7. Create the .env file skeleton ────────────────────────────────────────
echo "[7/7] Creating server/.env template..."
cat > "${DEPLOY_DIR}/server/.env" << 'EOF'
# ── FILL IN THESE VALUES BEFORE STARTING THE SERVER ──────────────────────────
PORT=4100

# 64 hex chars: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
CRM_MASTER_KEY=

# Leave blank for offline AI, or set your Anthropic key for live Claude
ANTHROPIC_API_KEY=

CRM_AI_RESIDENCY=hybrid

# Add other integrations (WhatsApp, Cube, Meta, SMTP) as needed:
# See server/.env.example in the repo for the full list
EOF

chmod 600 "${DEPLOY_DIR}/server/.env"
echo "[7/7] .env template created at ${DEPLOY_DIR}/server/.env"

# ── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════════════════════"
echo " Bootstrap complete! Next steps:"
echo "══════════════════════════════════════════════════════════════"
echo ""
echo " 1. Fill in the secrets:"
echo "    nano ${DEPLOY_DIR}/server/.env"
echo ""
echo " 2. Start the app container:"
echo "    cd ${DEPLOY_DIR}"
echo "    GITHUB_REPOSITORY_OWNER=${GITHUB_USER} docker compose pull"
echo "    GITHUB_REPOSITORY_OWNER=${GITHUB_USER} docker compose up -d"
echo ""
echo " 3. Seed the database (first time only):"
echo "    docker compose exec app node server/src/seed.js"
echo ""
echo " 4. Configure BT Panel Nginx:"
echo "    - Open BT Panel → Website → labs.tinyepic.in → Config"
echo "    - Paste the contents of nginx/nginx.conf (location blocks)"
echo "      into the server{} block for labs.tinyepic.in"
echo "    - SSL is already managed by BT Panel — no Certbot needed separately"
echo ""
echo " App will be live at: https://${DOMAIN}/ai-crm"
echo "══════════════════════════════════════════════════════════════"
