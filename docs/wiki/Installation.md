# Установка OpenDoist одной командой

На Linux-сервере с доступом root/sudo и установленным `curl`:

```bash
curl -fsSL https://raw.githubusercontent.com/lensws/opendoist/main/install/install.sh | sudo bash
```

Если вы уже root, замените `sudo bash` на `bash`. Мастер спросит домен и пароль (от 12 символов, ввод скрыт). Пароль не печатается и не передаётся в аргументах команд. Пустой домен означает доступ только через localhost или SSH-туннель.

Установщик и приложение по умолчанию берутся из **main**. Для тестовой версии:

```bash
curl -fsSL https://raw.githubusercontent.com/lensws/opendoist/main/install/install.sh | sudo bash -s -- --ref beta
```

Вместо `beta` можно передать полный SHA. Установщик не меняет ветку main и не настраивает GitHub Actions нового сервера.

## Требования

- На Ubuntu/Debian устанавливаются недостающие Git, curl, сертификаты, iproute2 и Docker Engine с Compose из официального Docker apt-репозитория. Нужны поддерживаемый Docker выпуск ОС и systemd. Уже установленный Docker не заменяется; при отсутствии Compose установите его плагин самостоятельно. Конфликтующие пакеты автоматически не удаляются.
- На других Linux заранее установите Docker Engine, Compose v2 с поддержкой `up --wait`, Git, curl, iproute2 и util-linux. Docker daemon должен работать.
- Для HTTPS нужны A-запись домена на сервер, корректная AAAA при использовании IPv6 и свободные входящие TCP-порты 80/443. Откройте их в firewall и панели провайдера, сохранив SSH-доступ. DNS и firewall установщик не изменяет.
- Если 80/443 уже заняты Nginx/Caddy, используйте `--local` и свой reverse proxy. Конфигурация `/etc/caddy` не заменяется.

[Официальная инструкция Docker для apt](https://docs.docker.com/engine/install/ubuntu/#install-using-the-apt-repository).

## Параметры

```bash
curl -fsSL https://raw.githubusercontent.com/lensws/opendoist/main/install/install.sh \
  | sudo bash -s -- --domain tasks.example.org --dir /opt/mytasks --port 3100
```

`--dir` по умолчанию `/opt/opendoist` (абсолютный путь без пробелов и точек). `--port` — локальный порт приложения, по умолчанию 3000. `--domain` включает отдельный контейнер Caddy с HTTPS, `--local` отключает его. Без этих параметров мастер спросит домен.

Для запуска без терминала также передайте `--password-file /root/opendoist-password.txt`: пароль в одну строку, права файла 600. После установки исходный файл можно удалить.

Чтобы сначала прочитать скрипт:

```bash
curl -fsSL https://raw.githubusercontent.com/lensws/opendoist/main/install/install.sh -o opendoist-install.sh
less opendoist-install.sh
sudo bash opendoist-install.sh --help
sudo bash opendoist-install.sh
```

## Результат

- `source/` — исходники, закреплённые на конкретном SHA.
- `.env` — пароль, адрес, порт и уникальное имя Compose-проекта; права 600.
- `compose.yaml` — конфигурация контейнеров.
- `Caddyfile` — конфигурация HTTPS, если указан домен.
- `public-url` и `.opendoist-installer` — служебные файлы мастера.

Каталог доступен только root. SQLite и сертификаты находятся в именованных Docker-томах. Контейнеры запускаются после перезагрузки. Приложение слушает только `127.0.0.1`; с доменом снаружи доступны порты Caddy 80/443.

Мастер ждёт healthcheck приложения и проверяет HTTPS отдельно. Если сертификат ещё не получен, он завершится с ошибкой: проверьте DNS/порты и повторите команду. Данные и конфигурация сохранятся.

Для `--local` откройте туннель **со своего компьютера**:

```bash
ssh -L 3000:127.0.0.1:3000 root@YOUR_VPS
```

Откройте `http://localhost:3000`. При другом порте замените оба числа: адрес браузера должен совпадать с `PUBLIC_URL`.

## Повторный запуск и управление

Повторная команда в том же каталоге **не меняет пароль, домен, порт или SHA**, даже с другими аргументами. Она собирает и запускает выбранную версию. Чужой каталог без маркера установщика не изменяется — выберите другой `--dir`.

Команды ниже выполняются от root. Замените каталог, если использовали `--dir`:

```bash
cd /opt/opendoist
docker compose ps
docker compose logs --tail=50 opendoist
# При HTTPS:
docker compose logs --tail=50 caddy
```

Не выводите `.env` и `docker compose config`: они содержат пароль. Для проверки используйте `docker compose config --quiet`.

## Обновление

Повторный запуск мастера сохраняет прежний SHA. Для новой версии используйте [обновление до последнего main](https://github.com/lensws/opendoist/wiki/Updating): ручная команда, backup, откат и необязательный systemd-таймер.

Наши порталы обновляются через [GitHub Actions](https://github.com/lensws/opendoist/wiki/Deployment). Установщик поверх них не запускайте.

## Автоматические резервные копии

После установки откройте **Настройки → Резервное копирование**. В Docker можно
использовать `/app/data/backups` или подключить другую папку хоста как volume.
Доступны S3 и расписание раз в час/сутки/неделю. Копия включает все файлы задач.
[Настройка и восстановление](https://github.com/lensws/opendoist/wiki/Backups).
