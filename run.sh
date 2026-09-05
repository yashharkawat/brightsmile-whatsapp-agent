#!/bin/zsh
# Supervisor: starts the agent + ngrok tunnel, records the public URL, and (if WHATSAPP_APP_SECRET is set)
# re-points the Meta webhook at the new URL. Used by launchd (com.yash.brightsmile-agent).
set -u
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:$HOME/.nvm/versions/node/v22.22.0/bin:/usr/local/bin:/usr/bin:/bin"
set -a; source ./.env; set +a
PORT="${PORT:-8790}"
META_APP_ID=1572494334675766
mkdir -p data logs

node --no-warnings src/index.js >> logs/agent.log 2>&1 &
AGENT=$!
if [ -f ./ngrok.yml ]; then
  # personal ngrok account (static dev domain); ngrok.yml holds only that authtoken, chmod 600
  ngrok http "$PORT" --config ./ngrok.yml --url=overbashful-seema-postulational.ngrok-free.dev --log stdout --log-format json >> logs/ngrok.log 2>&1 &
else
  ngrok http "$PORT" --log stdout --log-format json >> logs/ngrok.log 2>&1 &
fi
NGROK=$!

URL=""
for i in {1..30}; do
  sleep 1
  URL=$(curl -s localhost:4040/api/tunnels | python3 -c "import json,sys;t=json.load(sys.stdin)['tunnels'];print(t[0]['public_url'] if t else '')" 2>/dev/null)
  [ -n "$URL" ] && break
done
echo "$(date -Iseconds) public_url=$URL" >> logs/agent.log
echo "$URL" > data/public_url.txt

if [ -n "$URL" ] && [ -n "${WHATSAPP_APP_SECRET:-}" ]; then
  # App access token = app_id|app_secret ; update the WhatsApp Business Account webhook subscription
  RESP=$(curl -s -X POST "https://graph.facebook.com/v21.0/$META_APP_ID/subscriptions" \
    -d "object=whatsapp_business_account" -d "callback_url=$URL/webhook" \
    -d "verify_token=${WHATSAPP_VERIFY_TOKEN:-brightsmile-verify-2026}" -d "fields=messages" \
    -d "access_token=$META_APP_ID|$WHATSAPP_APP_SECRET")
  echo "$(date -Iseconds) meta_webhook_update=$RESP" >> logs/agent.log
else
  echo "$(date -Iseconds) WHATSAPP_APP_SECRET not set: update the Meta callback URL by hand to $URL/webhook" >> logs/agent.log
fi

wait $AGENT $NGROK
