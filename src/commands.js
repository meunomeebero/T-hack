const COMMAND_SETS = {
  easy: [
    "whoami",
    "id -un",
    "date",
    "uptime",
    "hostname",
    "pwd",
    "ls -la",
    "df -h",
    "free -m",
    "uname -a",
    "env",
    "history",
    "clear && ls",
    "jobs",
    "alias",
    "groups",
    "last",
    "who -a",
    "ss -t",
    "ip addr",
    "ip route",
    "dig example.com",
    "nslookup api.dev",
    "ping -c 1 target",
    "traceroute host",
    "curl -I site.dev",
    "nc -vz host 22",
    "ssh root@server",
    "scp key root@box",
    "touch hack.sh",
    "mkdir payloads",
    "rm -f trace.log",
    "cat /etc/hosts",
    "cat /etc/passwd",
    "tail -f app.log",
    "head -n 20 auth.log",
    "less access.log",
    "vim exploit.sh",
    "nano notes.txt"
  ],
  medium: [
    "sudo apt update",
    "sudo systemctl status",
    "systemctl restart api",
    "journalctl -u nginx",
    "ps aux|grep node",
    "kill -9 process",
    "chmod 700 ~/.ssh",
    "chmod +x payload.sh",
    "chown user:group",
    "tar -xvf dump.tar",
    "tar -czf loot.tgz",
    "zip -r loot.zip logs",
    "unzip backup.zip",
    "find /tmp -name key",
    "find / -perm -4000",
    "grep -R token logs",
    "grep root /etc/passwd",
    "awk '{print $1}' log",
    "sed -i s/foo/bar/g",
    "cut -d: -f1 users",
    "sort access.log",
    "uniq -c ips.txt",
    "base64 payload.bin",
    "openssl rand -hex 16",
    "openssl sha256 file",
    "curl -X POST api",
    "curl -sL payload.dev",
    "wget http://host/a",
    "npm install ws",
    "npm run build",
    "node server.js",
    "git status",
    "git diff --stat",
    "git commit -m fix",
    "git pull --rebase",
    "docker ps",
    "docker logs api",
    "docker exec -it app sh",
    "sqlite3 data.db",
    "sqlite3 game.db .tables",
    "redis-cli ping",
    "psql -c select 1",
    "mysql -e status"
  ],
  hard: [
    "iptables -L -n",
    "iptables -F",
    "nmap -sV target",
    "nmap -p 1-1024 host",
    "tcpdump -i lo port 80",
    "tcpdump -nn host api",
    "netstat -tulnp",
    "ss -ltnp",
    "lsof -i :3000",
    "strace -p 1337",
    "gdb -q ./core",
    "strings binary|grep key",
    "xxd dump.bin|head",
    "hexdump -C secret",
    "sha256sum payload",
    "gpg --decrypt vault.gpg",
    "openssl enc -d -aes256",
    "ssh-keygen -t ed25519",
    "rsync -avz loot/ box:/tmp",
    "mount /dev/sda1 /mnt",
    "umount /mnt",
    "crontab -l",
    "crontab -e",
    "journalctl -xeu api",
    "systemctl daemon-reload",
    "docker compose up -d",
    "docker inspect bridge",
    "kubectl get pods",
    "kubectl logs deploy/api",
    "kubectl describe pod api",
    "kubectl port-forward pod/api 8080",
    "helm list -A",
    "terraform plan",
    "terraform state list",
    "aws sts get-caller-identity",
    "aws s3 ls s3://vault",
    "gcloud auth list",
    "az account show",
    "jq .token session.json",
    "jq -r .users[] dump.json",
    "python3 -m http.server",
    "python3 exploit.py",
    "node -e \"console.log(1)\"",
    "perl -ne 'print if /key/'"
  ]
};

const TARGETS = [
  "alpha",
  "bravo",
  "cache",
  "delta",
  "edge",
  "gate",
  "host",
  "node",
  "proxy",
  "relay",
  "root",
  "vault"
];

const FILES = [
  "access.log",
  "auth.log",
  "dump.sql",
  "keys.txt",
  "payload.sh",
  "report.md",
  "session.json",
  "shadow.bak",
  "trace.log",
  "users.csv"
];

const GENERATED_PATTERNS = [
  (target, file) => `grep ${target} ${file}`,
  (target, file) => `tail -n 50 ${file}`,
  (target, file) => `cp ${file} /tmp/${target}`,
  (target, file) => `mv ${file} ${target}.bak`,
  (target) => `curl -I ${target}.lan`,
  (target) => `ping -c 2 ${target}`,
  (target) => `ssh ops@${target}`,
  (target) => `dig ${target}.local`,
  (target) => `nmap -Pn ${target}`,
  (target) => `nc -vz ${target} 443`
];

function generateCommands(count) {
  const allCommands = buildCommandPool();
  const selected = [];
  const used = new Set();
  const buckets = ["easy", "medium", "medium", "hard", "hard"];

  for (let index = 0; index < count; index += 1) {
    const bucket = buckets[index] || randomItem(Object.keys(COMMAND_SETS));
    const candidates = shuffle(COMMAND_SETS[bucket]).concat(shuffle(allCommands));
    const command = candidates.find((item) => !used.has(item));

    if (command) {
      selected.push(command);
      used.add(command);
    }
  }

  while (selected.length < count && selected.length < allCommands.length) {
    const command = randomItem(allCommands);
    if (!used.has(command)) {
      selected.push(command);
      used.add(command);
    }
  }

  return selected;
}

function buildCommandPool() {
  const generated = [];

  for (const target of TARGETS) {
    for (const file of FILES) {
      for (const pattern of GENERATED_PATTERNS) {
        generated.push(pattern(target, file));
      }
    }
  }

  return unique([
    ...COMMAND_SETS.easy,
    ...COMMAND_SETS.medium,
    ...COMMAND_SETS.hard,
    ...generated
  ]).filter((command) => command.length <= 34);
}

function randomItem(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function shuffle(items) {
  const copy = items.slice();

  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }

  return copy;
}

function unique(items) {
  return Array.from(new Set(items));
}

module.exports = {
  buildCommandPool,
  generateCommands
};
