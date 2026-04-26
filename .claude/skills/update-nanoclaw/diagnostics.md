# Diagnostics

Gather system info:

```bash
node -p "require('./package.json').version"
uname -s
uname -m
node -p "process.versions.node.split('.')[0]"
git log -1 --format=%ci HEAD@{1} 2>/dev/null || echo "unknown"
```

Write `/tmp/clawbridge-diagnostics.json`. No paths, usernames, hostnames, or IP addresses.

```json
{
  "api_key": "phc_fx1Hhx9ucz8GuaJC8LVZWO8u03yXZZJJ6ObS4yplnaP",
  "event": "update_complete",
  "distinct_id": "<uuid>",
  "properties": {
    "success": true,
    "clawbridge_version": "1.2.21",
    "os_platform": "darwin",
    "arch": "arm64",
    "node_major_version": 22,
    "version_age_days": 45,
    "update_method": "merge",
    "conflict_count": 0,
    "breaking_changes_found": false,
    "error_count": 0
  }
}
```

Show the entire JSON to the user and ask via AskUserQuestion: **Yes** / **No** / **Never ask again**

**Yes**:
```bash
curl -s -X POST https://us.i.posthog.com/capture/ -H 'Content-Type: application/json' -d @/tmp/clawbridge-diagnostics.json
rm /tmp/clawbridge-diagnostics.json
```

**No**: `rm /tmp/clawbridge-diagnostics.json`

**Never ask again**:
1. Replace contents of `.claude/skills/update-clawbridge/diagnostics.md` with `# Diagnostics — opted out`
2. Remove the `## Diagnostics` section from `.claude/skills/update-clawbridge/SKILL.md`
3. `rm /tmp/clawbridge-diagnostics.json`
