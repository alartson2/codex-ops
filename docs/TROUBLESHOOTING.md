# Troubleshooting

## Bot is running but does not reply

1. Validate Telegram token and allowed chat IDs:

```bash
sudo grep -E '^(TELEGRAM_BOT_TOKEN|ALLOWED_CHAT_IDS)=' /etc/codex-ops/bot.env
```

2. Check service logs:

```bash
sudo journalctl -u codex-telegram-bot.service -n 200 --no-pager
```

3. Verify Codex login status:

```bash
sudo /opt/codex-ops/scripts/codex-auth.sh status
```

## Flood of Telegram messages

- reduce `MAX_MESSAGE_CHUNKS`
- increase `OUTBOUND_DELAY_MS`
- keep raw stdout/stderr disabled for Telegram fallback
- check logs for 429 retries

## Repeated "Codex did not return a final answer"

When Codex does not return final output, bot writes diagnostics into `STATE_DIR`:

- `codex-debug-<timestamp>.log`

Use these files to inspect stdout/stderr and decide whether the issue is auth, timeout, or model-side.

## Native auth returns 403

Perform full auth refresh:

```bash
sudo /opt/codex-ops/scripts/codex-auth.sh logout
sudo /opt/codex-ops/scripts/codex-auth.sh login
sudo systemctl restart codex-telegram-bot.service
```

## Docker access issues for codexops user

If diagnostics fail with docker permissions:

```bash
sudo usermod -aG docker codexops
sudo systemctl restart codex-telegram-bot.service
```

## Offset/history corruption suspicion

Clear runtime state files (with service stopped) only if needed:

```bash
sudo systemctl stop codex-telegram-bot.service
sudo rm -f /var/lib/codexops/state/telegram-offset.txt
sudo rm -f /var/lib/codexops/state/chat-state.json
sudo systemctl start codex-telegram-bot.service
```

Use with care: this resets local polling offset and in-bot session history.
