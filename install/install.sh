#!/usr/bin/env bash
# OpenDoist Linux installer. Define functions before invoking installation at EOF.
set -euo pipefail
set +x
umask 077
fail() { printf 'Ошибка: %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'HELP'
OpenDoist: установка на Linux (root / sudo bash)
  --dir PATH           Каталог установки (по умолчанию /opt/opendoist)
  --ref main|beta|SHA   Версия приложения (по умолчанию main)
  --domain NAME        Домен HTTPS; --local для доступа через SSH-туннель
  --port NUMBER        Локальный порт приложения (по умолчанию 3000)
  --password-file PATH Пароль из файла вместо интерактивного ввода
  --help               Справка
Повторный запуск сохраняет версию, конфигурацию и данные. Обновление — отдельная операция.
HELP
}
valid_domain() { [[ ${#1} -le 253 && $1 =~ ^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$ ]]; }
# Double-quoted Compose dotenv escaping: quotes/backslashes plus literal dollars.
dotenv_value() {
  local value=$1
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//\$/\\\$}
  printf '"%s"' "$value"
}
prompt() { [[ -r /dev/tty ]] || fail 'Нет терминала: укажите --domain/--local и --password-file.'; printf '%s' "$1" >/dev/tty; IFS= read -r "$2" </dev/tty; }
compose() { ( unset OPENDOIST_PASSWORD PUBLIC_URL COOKIE_SECURE PORT COMPOSE_PROJECT_NAME; docker compose --project-directory "$install_dir" --env-file "$install_dir/.env" -f "$install_dir/compose.yaml" "$@" ); }
port_available() { local listeners; listeners=$(ss -H -ltn) || fail 'Не удалось проверить занятые порты.'; ! awk -v port="$1" '$4 ~ (":" port "$") {found=1} END {exit !found}' <<<"$listeners"; }
install_dependencies() {
  local ID='' VERSION_CODENAME='' UBUNTU_CODENAME=''
  [[ -f /etc/os-release ]] && . /etc/os-release
  if ! command -v git >/dev/null || ! command -v curl >/dev/null || ! command -v ss >/dev/null; then
    [[ $ID == ubuntu || $ID == debian ]] || fail 'Установите git, curl и iproute2 (ss), затем повторите запуск.'
    apt-get update
    apt-get install -y git curl ca-certificates iproute2
  fi
  if ! command -v docker >/dev/null; then
    [[ $ID == ubuntu || $ID == debian ]] || fail 'Автоустановка Docker поддерживается на Ubuntu/Debian. На других Linux установите Docker Engine и Compose v2 заранее.'
    local codename=${UBUNTU_CODENAME:-$VERSION_CODENAME}
    [[ $codename =~ ^[a-z]+$ ]] || fail 'Не удалось определить выпуск ОС.'
    for package in docker.io docker-compose containerd runc podman-docker; do
      if dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q 'install ok installed'; then fail "Найден $package. Установите Docker/Compose вручную: существующие пакеты автоматически не удаляются."; fi
    done
    printf 'Устанавливаем Docker из официального apt-репозитория…\n'
    apt-get update
    apt-get install -y ca-certificates curl
    if [[ ! -f /etc/apt/sources.list.d/opendoist-docker.sources ]]; then
    install -m 0755 -d /etc/apt/keyrings
    curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 https://download.docker.com/linux/"$ID"/gpg -o /etc/apt/keyrings/opendoist-docker.asc
    chmod 644 /etc/apt/keyrings/opendoist-docker.asc
    cat > /etc/apt/sources.list.d/opendoist-docker.sources <<SOURCES
Types: deb
URIs: https://download.docker.com/linux/$ID
Suites: $codename
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/opendoist-docker.asc
SOURCES
    chmod 644 /etc/apt/sources.list.d/opendoist-docker.sources
    fi
    apt-get update
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    systemctl enable --now docker
  fi
  docker compose version >/dev/null 2>&1 || fail 'Нужен Docker Compose v2 (docker compose). Установите плагин Compose для вашего Docker.'
  docker info >/dev/null 2>&1 || fail 'Docker недоступен. Запустите Docker daemon и повторите установку.'
}
main() {
  install_dir=/opt/opendoist
  local ref=main domain='' domain_set=false port=3000 password_file='' option
  while (($#)); do
    option=$1; shift
    case "$option" in
      --help|-h) usage; return ;;
      --local) domain=''; domain_set=true ;;
      --dir|--ref|--domain|--port|--password-file)
        (($#)) || fail "Нет значения для $option"
        case "$option" in
          --dir) install_dir=$1 ;; --ref) ref=$1 ;; --domain) domain=$1; domain_set=true ;; --port) port=$1 ;; --password-file) password_file=$1 ;;
        esac; shift ;;
      *) fail "Неизвестный аргумент: $option" ;;
    esac
  done
  [[ $install_dir =~ ^/[a-zA-Z0-9/_-]+$ && $install_dir != / && $install_dir != */ ]] || fail 'Каталог должен быть абсолютным путём без пробелов, точек и завершающего /.'
  [[ $ref == main || $ref == beta || $ref =~ ^[a-f0-9]{40}$ ]] || fail 'Версия: main, beta или полный SHA.'
  [[ $port =~ ^[1-9][0-9]{0,4}$ ]] && ((port <= 65535)) || fail 'Порт должен быть от 1 до 65535.'
  [[ -z $domain ]] || valid_domain "$domain" || fail 'Укажите доменное имя без https://, пути и порта.'
  [[ $(uname -s) == Linux ]] || fail 'Этот установщик предназначен для Linux.'
  ((EUID == 0)) || fail 'Запустите через sudo bash или от root.'
  command -v flock >/dev/null || fail 'Установите util-linux (flock).'
  [[ ! -L $install_dir ]] || fail 'Каталог установки не должен быть символической ссылкой.'
  if [[ -e $install_dir && ! -f $install_dir/.opendoist-installer ]]; then fail 'Каталог уже существует и не создан этим установщиком. Укажите другой --dir; действующие установки не изменены.'; fi
  if [[ -e $install_dir ]]; then
    [[ $(stat -c %u "$install_dir") == 0 ]] || fail 'Существующий каталог установщика должен принадлежать root.'
    for file in .env .env.tmp compose.yaml Caddyfile public-url .opendoist-installer .install.lock source; do
      [[ ! -L $install_dir/$file ]] || fail 'В каталоге установщика обнаружена символическая ссылка.'
    done
  fi
  mkdir -p "$install_dir"
  chmod 700 "$install_dir"
  exec 9>"$install_dir/.install.lock"
  flock -n 9 || fail 'Другой установщик уже работает.'
  printf '1\n' > "$install_dir/.opendoist-installer"
  install_dependencies
  if [[ ! -f $install_dir/.env ]]; then
    if [[ $domain_set == false ]]; then prompt 'Домен для HTTPS (пусто — только SSH-туннель): ' domain; fi
    [[ -z $domain ]] || valid_domain "$domain" || fail 'Некорректное доменное имя.'
    port_available "$port" || fail "Порт $port занят. Выберите другой --port."
    if [[ -n $domain ]]; then
      [[ $port != 80 && $port != 443 ]] || fail 'Выберите локальный порт, отличный от 80/443.'
      port_available 80 && port_available 443 || fail '80/443 заняты. Используйте --local и существующий reverse proxy по инструкции.'
    fi
    local password='' confirmation=''
    if [[ -n $password_file ]]; then
      [[ -f $password_file && -r $password_file ]] || fail 'Файл пароля недоступен.'
      password=$(<"$password_file")
    else
      [[ -r /dev/tty ]] || fail 'Нужен терминал или --password-file.'
      printf 'Пароль OpenDoist (не менее 12 символов): ' >/dev/tty; IFS= read -rs password </dev/tty; printf '\n' >/dev/tty
      printf 'Повторите пароль: ' >/dev/tty; IFS= read -rs confirmation </dev/tty; printf '\n' >/dev/tty
      [[ $password == "$confirmation" ]] || fail 'Пароли не совпадают.'
    fi
    [[ ${#password} -ge 12 && $password != change-this-before-use && $password != *$'\n'* && $password != *$'\r'* ]] || fail 'Нужен уникальный пароль от 12 символов в одну строку.'
    local url="http://localhost:$port" secure=false project_name
    if [[ -n $domain ]]; then url="https://$domain"; secure=true; fi
    project_name="opendoist-$(printf '%s' "$install_dir" | sha256sum | cut -c1-12)"
    {
      printf 'OPENDOIST_PASSWORD='; dotenv_value "$password"; printf '\n'
      printf 'PUBLIC_URL=%s\nCOOKIE_SECURE=%s\nPORT=%s\nCOMPOSE_PROJECT_NAME=%s\n' "$url" "$secure" "$port" "$project_name"
    } > "$install_dir/.env.tmp"
    unset password confirmation
    printf '%s\n' "$url" > "$install_dir/public-url"
    cat > "$install_dir/compose.yaml" <<'COMPOSE'
services:
  opendoist:
    build: ./source
    restart: unless-stopped
    init: true
    ports:
      - "127.0.0.1:${PORT}:3000"
    environment:
      OPENDOIST_PASSWORD: ${OPENDOIST_PASSWORD:?Set password}
      PUBLIC_URL: ${PUBLIC_URL}
      COOKIE_SECURE: ${COOKIE_SECURE}
    volumes:
      - opendoist-data:/app/data
    security_opt:
      - no-new-privileges:true
    cap_drop: [ALL]
    read_only: true
    tmpfs: [/tmp]
COMPOSE
    if [[ -n $domain ]]; then
      cat >> "$install_dir/compose.yaml" <<'CADDY'
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
CADDY
      printf '%s {\n  reverse_proxy opendoist:3000\n}\n' "$domain" > "$install_dir/Caddyfile"
    fi
    cat >> "$install_dir/compose.yaml" <<'VOLUMES'
volumes:
  opendoist-data:
  caddy-data:
  caddy-config:
VOLUMES
    mv "$install_dir/.env.tmp" "$install_dir/.env"
  else
    printf 'Сохраняем существующие настройки, пароль и версию. Аргументы конфигурации повторно не применяются.\n'
  fi
  if [[ ! -d $install_dir/source/.git ]]; then
    git init --quiet "$install_dir/source"
    git -C "$install_dir/source" remote add origin https://github.com/lensws/opendoist.git
  fi
  if ! git -C "$install_dir/source" rev-parse --verify HEAD >/dev/null 2>&1; then
    git -C "$install_dir/source" fetch --depth 1 origin "$ref"
    git -C "$install_dir/source" checkout --detach FETCH_HEAD
  fi
  compose config --quiet
  compose up -d --build --wait --wait-timeout 180
  compose exec -T opendoist node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
  local url; url=$(<"$install_dir/public-url")
  printf '\nOpenDoist запущен. Каталог: %s\nВерсия: ' "$install_dir"
  git -C "$install_dir/source" rev-parse HEAD
  if [[ $url == https:* ]]; then
    if curl --fail --silent --show-error --retry 6 --retry-delay 5 --retry-all-errors --max-time 10 "$url/healthz" >/dev/null; then
      printf 'HTTPS проверен: %s\n' "$url"
    else
      printf 'Приложение работает, но HTTPS ещё недоступен: %s\nПроверьте DNS (A/AAAA), входящие 80/443 и логи Caddy.\n' "$url" >&2
      return 1
    fi
  else
    printf 'Доступ: %s (на VPS используйте SSH-туннель к выбранному порту).\n' "$url"
  fi
  printf 'Вход — с указанным вами паролем. Пароль хранится в .env (доступ только root) и не выводится.\n'
}
main "$@"
