# VPS Hardening Guide for ClawBridge

A practical hardening checklist for a Linux VPS (Ubuntu/Debian) running ClawBridge. Commands are copy-paste ready. Run as your non-root sudo user unless otherwise noted.

---

## 1. SSH Key-Only Access

The single highest-impact security change. Disable password login and require an SSH key.

**On your local machine**, generate a key pair if you don't have one:

```bash
ssh-keygen -t ed25519 -C "your-email@example.com"
# Accept the default path (~/.ssh/id_ed25519) and set a passphrase
```

**Copy your public key to the server:**

```bash
ssh-copy-id -i ~/.ssh/id_ed25519.pub user@your-server-ip
```

Or manually — paste the contents of `~/.ssh/id_ed25519.pub` into `~/.ssh/authorized_keys` on the server.

**Verify key login works** before disabling passwords:

```bash
ssh -i ~/.ssh/id_ed25519 user@your-server-ip
```

**Disable password authentication on the server:**

```bash
sudo nano /etc/ssh/sshd_config
```

Find and set these lines (add them if missing):

```
PasswordAuthentication no
PubkeyAuthentication yes
PermitRootLogin no
```

Restart SSH:

```bash
sudo systemctl restart sshd
```

> **Warning**: Keep your current session open when restarting sshd. Open a second terminal and verify you can still connect before closing the first.

---

## 2. Firewall (UFW)

Default-deny all inbound traffic, then explicitly allow only what you need.

```bash
sudo apt install ufw -y

# Default rules
sudo ufw default deny incoming
sudo ufw default allow outgoing

# Allow SSH (do this BEFORE enabling UFW or you'll lock yourself out)
sudo ufw allow 22/tcp

# Allow any other ports your setup needs, for example:
# sudo ufw allow 80/tcp    # HTTP (if running a web dashboard)
# sudo ufw allow 443/tcp   # HTTPS

# Enable the firewall
sudo ufw enable

# Verify status
sudo ufw status verbose
```

To list and delete rules:

```bash
sudo ufw status numbered
sudo ufw delete <number>
```

---

## 3. Fail2ban (SSH Brute Force Protection)

Fail2ban monitors log files and bans IPs that show malicious signs (repeated failed logins).

```bash
sudo apt install fail2ban -y
```

Create a local config override (do not edit `/etc/fail2ban/jail.conf` directly — it gets overwritten on updates):

```bash
sudo nano /etc/fail2ban/jail.local
```

Paste:

```ini
[DEFAULT]
bantime  = 1h
findtime = 10m
maxretry = 5

[sshd]
enabled = true
port    = ssh
logpath = %(sshd_log)s
backend = %(sshd_backend)s
```

Enable and start:

```bash
sudo systemctl enable fail2ban
sudo systemctl start fail2ban

# Verify it's running and watching SSH
sudo fail2ban-client status sshd
```

To unban an IP:

```bash
sudo fail2ban-client set sshd unbanip <ip-address>
```

---

## 4. Docker Security

**Do not run containers as root.** ClawBridge containers run as non-root by default — don't override this.

**Keep Docker updated:**

```bash
sudo apt update && sudo apt upgrade docker-ce docker-ce-cli containerd.io -y
```

**Do not add your user to the `docker` group** unless necessary. The docker group grants effective root access. Use `sudo docker` instead, or configure rootless Docker:

```bash
# Check if your user is in the docker group
groups $USER

# If you need to remove it (requires logout to take effect)
sudo gpasswd -d $USER docker
```

**Limit container capabilities** — ClawBridge does this by default. If you modify `container-runner.ts`, never add `--privileged` or `--cap-add SYS_ADMIN` to container spawn flags.

**Verify no containers are running as root:**

```bash
docker ps -q | xargs -I{} docker inspect {} --format '{{.Id}} User: {{.Config.User}}'
```

---

## 5. Automatic Security Updates

Enable unattended-upgrades to automatically apply security patches:

```bash
sudo apt install unattended-upgrades apt-listchanges -y
sudo dpkg-reconfigure --priority=low unattended-upgrades
# Select "Yes" when prompted
```

Verify the config:

```bash
cat /etc/apt/apt.conf.d/20auto-upgrades
```

Should contain:

```
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
```

To configure which upgrades are automatic, edit:

```bash
sudo nano /etc/apt/apt.conf.d/50unattended-upgrades
```

The default only applies security updates — leave it that way unless you have a reason to change it.

---

## 6. Full-Disk Encryption

**This must be done at provisioning time.** You cannot encrypt a running VPS after the fact without reinstalling.

Most major VPS providers offer encrypted volumes at setup:

- **Hetzner Cloud**: Enable volume encryption when creating the server or attaching a volume
- **DigitalOcean**: Enable volume encryption when creating a Droplet volume
- **AWS EC2**: Enable EBS encryption at volume creation (can be set as the account default)
- **Linode/Akamai**: Use StackScripts or manual LUKS setup during OS install

If your VPS is already running without encryption, consider this for your next provisioning. For most ClawBridge installs, filesystem-level encryption of `~/.clawbridge/` (via `fscrypt` or `eCryptFS`) is a practical middle ground if full-disk encryption isn't available.

---

## 7. ClawBridge-Specific Hardening

**Protect your `.env` file.** It contains your API keys and credentials — restrict it to owner-read-only:

```bash
chmod 600 ~/.clawbridge/.env
ls -la ~/.clawbridge/.env
# Should show: -rw------- 1 youruser youruser ...
```

**Keep ClawBridge updated:**

```bash
npx clawbridge-agent upgrade
```

Or if using git:

```bash
cd ~/clawbridge-agent && git pull && pnpm install
```

**Audit mounted paths.** Containers only have access to what's explicitly mounted. Review mounts for any group you add — especially groups with `additionalMounts`:

```bash
docker inspect <container-name> | jq '.[].HostConfig.Binds'
```

**Review logs periodically** for unexpected behavior:

```bash
# ClawBridge logs (adjust path to your install)
tail -f ~/.clawbridge/logs/host.log

# Container stdout
docker logs <container-name> --tail 100 -f
```

---

## Summary Checklist

- [ ] SSH keys configured, password auth disabled
- [ ] UFW enabled with default-deny inbound
- [ ] Only required ports open (22, plus any others you need)
- [ ] Fail2ban installed and monitoring SSH
- [ ] Docker running up to date, containers not running as root
- [ ] Unattended-upgrades enabled for security patches
- [ ] Full-disk or volume encryption noted for next provisioning
- [ ] `~/.clawbridge/.env` has `600` permissions
- [ ] ClawBridge updated to latest version
