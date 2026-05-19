const COMMAND_SETS = {
  easy: [
    "whoami",
    "date",
    "uptime",
    "hostname",
    "pwd",
    "env",
    "history",
    "jobs",
    "alias",
    "groups",
    "last",
    "ls",
    "ls home",
    "ls var",
    "top",
    "htop",
    "ps",
    "df",
    "du",
    "free",
    "man bash",
    "vim",
    "nano",
    "exit",
    "logout",
    "yes",
    "true",
    "false",
    "echo hello",
    "echo world",
    "ip addr",
    "ip route",
    "ping host",
    "ping server",
    "dig host",
    "curl host",
    "ssh server",
    "scp file",
    "touch file",
    "mkdir payloads",
    "rm file",
    "cat hosts",
    "cat passwd",
    "tail log",
    "head log",
    "less log",
    "more log",
    "cd home",
    "cd var",
    "wc lines",
    "tr lower upper",
    "id user",
    "tty",
    "hostid",
    "domainname",
    "uptime hours",
    "users",
    "who",
    "w"
  ],
  medium: [
    "sudo apt update",
    "sudo apt upgrade",
    "sudo systemctl status",
    "systemctl restart api",
    "systemctl stop api",
    "systemctl start api",
    "journalctl nginx",
    "journalctl api",
    "chown user group",
    "chmod 700 ssh",
    "chmod 755 bin",
    "tar xvf dump",
    "tar czf loot",
    "zip loot logs",
    "unzip backup",
    "grep token logs",
    "grep root passwd",
    "grep error log",
    "sort access",
    "uniq counts",
    "base64 payload",
    "openssl rand 16",
    "openssl sha256",
    "curl host",
    "curl post host",
    "wget host file",
    "npm install ws",
    "npm install express",
    "npm run build",
    "npm run dev",
    "npm test",
    "node server",
    "node index",
    "git status",
    "git diff",
    "git add",
    "git commit fix",
    "git pull",
    "git push",
    "git log",
    "git fetch",
    "docker ps",
    "docker logs api",
    "docker stop api",
    "docker exec api",
    "docker pull node",
    "sqlite data",
    "redis cli ping",
    "psql select",
    "mysql status",
    "mongo show dbs",
    "make build",
    "make test",
    "make install",
    "make clean"
  ],
  hard: [
    "iptables list",
    "iptables flush",
    "nmap target",
    "nmap host",
    "tcpdump lo",
    "tcpdump host api",
    "netstat tulnp",
    "ss ltnp",
    "lsof 3000",
    "strace pid",
    "gdb core",
    "hexdump secret",
    "sha256sum payload",
    "gpg decrypt vault",
    "openssl aes256",
    "ssh keygen",
    "ssh keygen ed25519",
    "rsync loot box",
    "mount sda1",
    "umount mnt",
    "crontab list",
    "crontab edit",
    "systemctl daemon reload",
    "docker compose up",
    "docker compose down",
    "docker inspect bridge",
    "docker network list",
    "kubectl get pods",
    "kubectl get nodes",
    "kubectl get services",
    "kubectl describe pod",
    "kubectl logs api",
    "kubectl port forward",
    "kubectl apply",
    "kubectl delete pod",
    "helm list",
    "helm install",
    "terraform plan",
    "terraform apply",
    "terraform state list",
    "terraform init",
    "aws sts identity",
    "aws s3 list",
    "gcloud auth list",
    "az account show",
    "python3 http server",
    "python3 exploit",
    "node debug",
    "perl scan",
    "ruby exploit",
    "go run main",
    "go build",
    "go test",
    "cargo build",
    "cargo run"
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
  "access",
  "auth",
  "dump",
  "keys",
  "payload",
  "report",
  "session",
  "shadow",
  "trace",
  "users"
];

const GENERATED_PATTERNS = [
  (target, file) => `grep ${target} ${file}`,
  (target, file) => `tail 50 ${file}`,
  (target, file) => `cp ${file} ${target}`,
  (target, file) => `mv ${file} ${target}`,
  (target) => `curl ${target}`,
  (target) => `ping ${target}`,
  (target) => `ssh ops ${target}`,
  (target) => `dig ${target}`,
  (target) => `nmap ${target}`,
  (target) => `nc ${target} 443`
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
  ]).filter((command) => command.length <= 34 && SAFE_COMMAND.test(command));
}

// Letters, digits and spaces only. Every symbol is excluded because some
// layout (70% Mac PT-BR, etc) either uses a dead key for it or hides it
// behind altgr/fn modifiers.
const SAFE_COMMAND = /^[A-Za-z0-9 ]+$/;

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
