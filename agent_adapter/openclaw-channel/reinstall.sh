#!/usr/bin/env sh

cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.bk -f

openclaw plugins uninstall agent-club --force
rm /root/.openclaw/extensions/agent-club -rf

npm run build
openclaw plugins install .

cp ~/.openclaw/openclaw.json.bk ~/.openclaw/openclaw.json -f

supervisorctl restart openclaw_gateway

netstat -lan | grep 5555