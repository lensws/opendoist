# Обновление OpenDoist

«Последняя стабильная версия» здесь — текущий commit ветки `main`. Версия для проверки — `beta`. GitHub Releases и отдельного реестра готовых Docker-образов пока нет. При выборе SHA убедитесь, что его `Tests and Docker build` завершился успешно в [Actions](https://github.com/lensws/opendoist/actions).

Обновление сохраняет `.env` и Docker-том с базой. `docker compose down -v` удаляет данные: для обновления эта команда не нужна. Перед обновлением нужна полная SQLite-копия; JSON-экспорт её не заменяет.

## Какой у вас способ установки

| Установка | Где исходники | Как обновляться |
| --- | --- | --- |
| Мастер `curl … install.sh` | `/opt/opendoist/source` | Скрипт ниже, вручную или по таймеру |
| Обычный `git clone` + Compose | Каталог с `compose.yaml` | Раздел «Ручной Docker» ниже |
| Наши `do.lensws.be` и `enki.lensws.be` | `/opt/opendoist/prod`, `/opt/opendoist/enki` | Автоматически при выпуске `main` после тестов |
| Локальный Node.js | Каталог репозитория | Раздел «Node.js» ниже |

**Повторный запуск установщика не обновляет приложение:** он сохраняет ранее выбранный SHA. Скрипт ниже предназначен только для его установки, не для наших prod/beta/enki.

## После установки мастером: один раз подготовить команду обновления

Выполните на сервере от root. Скрипт хранится отдельно от исходников приложения. Он обновляет только `main`, делает backup, сохраняет прежний SHA/образ и пытается откатить код при ошибке активации. Пароли не выводятся. Настройки HTTPS не меняются.

```bash
sudo tee /usr/local/sbin/opendoist-update >/dev/null <<'SCRIPT'
#!/bin/bash
set -Eeuo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
[[ $EUID == 0 ]] || { echo 'Запустите через sudo'; exit 1; }
install_dir=${1:-/opt/opendoist}
[[ $install_dir =~ ^/[a-zA-Z0-9/_-]+$ && -f $install_dir/.opendoist-installer ]] || { echo 'Нужен каталог установки мастером'; exit 1; }
cd "$install_dir"
exec 9>.install.lock
flock -w 600 9
compose() { ( unset OPENDOIST_PASSWORD PUBLIC_URL COOKIE_SECURE PORT COMPOSE_PROJECT_NAME; docker compose --project-directory "$install_dir" --env-file "$install_dir/.env" -f "$install_dir/compose.yaml" "$@" ); }
[[ -z $(git -C source status --porcelain) ]] || { echo 'В исходниках есть изменения; сохраните их отдельно'; exit 1; }
git -C source fetch origin main
next=$(git -C source rev-parse FETCH_HEAD)
previous=$(git -C source rev-parse HEAD)
if [[ $next == "$previous" ]]; then echo "Уже актуально: $next"; exit 0; fi
container=$(compose ps -q opendoist)
[[ -n $container ]] || { echo 'Сначала запустите установленный экземпляр'; exit 1; }
previous_image=$(docker inspect --format '{{.Image}}' "$container")
image_tag=$(docker inspect --format '{{.Config.Image}}' "$container")
rollback() {
  code=$?
  trap - ERR
  git -C source checkout --detach "$previous"
  docker image tag "$previous_image" "$image_tag"
  if compose up -d --no-build --wait --wait-timeout 180; then
    echo "Возвращён код $previous; база не перезаписана"
  else
    echo 'Откат не прошёл healthcheck: проверьте журнал и резервную копию' >&2
  fi
  exit "$code"
}
trap rollback ERR
git -C source checkout --detach "$next"
compose build opendoist
stamp="$(date -u +%Y%m%dT%H%M%SZ)-$$"
install -d -m 700 backups
compose exec -T opendoist node server/backup.js "/app/data/update-$stamp.sqlite" </dev/null
compose cp "opendoist:/app/data/update-$stamp.sqlite" "backups/$stamp.sqlite"
chmod 600 "backups/$stamp.sqlite"
printf '%s\n' "$previous" > "backups/$stamp.previous-sha"
compose exec -T opendoist rm -- "/app/data/update-$stamp.sqlite" </dev/null
compose up -d --no-build --wait --wait-timeout 180
curl --fail --silent --show-error --retry 3 --retry-delay 3 "$(cat public-url)/healthz"
trap - ERR
printf '\nОбновлено до %s; backup: %s/backups/%s.sqlite\n' "$next" "$install_dir" "$stamp"
SCRIPT
sudo chmod 755 /usr/local/sbin/opendoist-update
```

Теперь обновление — одна команда:

```bash
sudo /usr/local/sbin/opendoist-update
```

При установке с другим `--dir` передайте его:

```bash
sudo /usr/local/sbin/opendoist-update /opt/mytasks
```

Сборка идёт при работающем старом контейнере; при замене возможна короткая пауза. Backup сохраняется в `backups/` каталога установки. Скрипт проверяет готовность контейнера и доступность сайта. Сам он не проверяет GitHub Actions: используйте доверенный `main`, в который выпускаются проверенные изменения. Для строгого условия «сначала CI, затем деплой» используйте [GitHub Actions](https://github.com/lensws/opendoist/wiki/Deployment).

## Автоматически: systemd раз в сутки

Необязательный режим для самостоятельной установки мастером. Он запускает ту же команду ежедневно в 04:00 **по часовому поясу сервера**, со случайной задержкой до 15 минут. Он принимает все новые изменения `main` без вашего просмотра. При выключенном сервере пропущенный запуск выполнится после включения.

Сначала выполните ручное обновление выше и убедитесь, что оно успешно. Затем:

```bash
sudo tee /etc/systemd/system/opendoist-update.service >/dev/null <<'UNIT'
[Unit]
Description=Update OpenDoist from main with SQLite backup
Wants=network-online.target
After=network-online.target docker.service
Requires=docker.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/opendoist-update /opt/opendoist
TimeoutStartSec=30min
UNIT
sudo tee /etc/systemd/system/opendoist-update.timer >/dev/null <<'UNIT'
[Unit]
Description=Daily OpenDoist update

[Timer]
OnCalendar=*-*-* 04:00:00
RandomizedDelaySec=15min
Persistent=true

[Install]
WantedBy=timers.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now opendoist-update.timer
systemctl list-timers opendoist-update.timer
```

При другом каталоге измените аргумент `ExecStart`. Часовой пояс сервера показывает `timedatectl`. Диагностика и отключение:

```bash
sudo journalctl -u opendoist-update.service -n 100 --no-pager
sudo systemctl status opendoist-update.service --no-pager
sudo systemctl disable --now opendoist-update.timer
```

Таймер сам не отправляет уведомления об ошибках. Контролируйте его статус и свободное место: старые копии автоматически не удаляются. Храните копии также вне VPS. Не включайте этот таймер поверх GitHub Actions для того же экземпляра.

## Ручной Docker: установка через git clone

В каталоге с `compose.yaml` и `.env` выполните блок целиком. Если вы не root, используйте оболочку `sudo -i`. Перед запуском убедитесь, что `git status --short` пуст, и сохраните локальные изменения отдельно.

```bash
(
  set -e
  mkdir -p backups
  chmod 700 backups
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  git rev-parse HEAD > "backups/$stamp.previous-sha"
  docker compose exec -T opendoist node server/backup.js "/app/data/update-$stamp.sqlite"
  docker compose cp "opendoist:/app/data/update-$stamp.sqlite" "backups/$stamp.sqlite"
  chmod 600 "backups/$stamp.sqlite"
  docker compose exec -T opendoist rm -- "/app/data/update-$stamp.sqlite"
  git fetch origin main
  git checkout --detach FETCH_HEAD
  docker compose up -d --build --wait --wait-timeout 180
  git rev-parse HEAD
)
```

Затем проверьте `https://ваш-домен/healthz` и вход в приложение. Для тестовой ветки замените `main` на `beta`. Для конкретной версии используйте полный проверенный SHA вместо `FETCH_HEAD`.

## Node.js без Docker

Остановите процесс приложения через используемый менеджер процессов. В каталоге проекта сохраните прежний SHA и базу, затем обновитесь:

```bash
(
  set -e
  mkdir -p backups
  chmod 700 backups
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  git rev-parse HEAD > "backups/$stamp.previous-sha"
  node --env-file-if-exists=.env server/backup.js "backups/$stamp.sqlite"
  chmod 600 "backups/$stamp.sqlite"
  git fetch origin main
  git checkout --detach FETCH_HEAD
  npm ci
  npm test
)
```

Нужен Node.js 24+. Перезапустите приложение штатным менеджером процессов (для запуска в терминале — `npm start`) и проверьте `/healthz`. Если задан нестандартный `DATABASE_PATH`, передайте его и скрипту backup.

## Откат

Остановите таймер, если он включён, иначе он снова установит текущий `main`. Прежний SHA записан рядом с backup в `*.previous-sha`.

Для установки мастером: `git -C /opt/opendoist/source checkout --detach <прежний-SHA>`, затем из `/opt/opendoist` — `docker compose up -d --build --wait --wait-timeout 180`. Для обычного клона выполните `git checkout --detach <прежний-SHA>` в его каталоге. Для Node.js после checkout выполните `npm ci` и перезапуск.

Откат кода не откатывает базу. Если новая версия внесла несовместимое изменение схемы, потребуется [восстановление SQLite](https://github.com/lensws/opendoist/wiki/Backups). Восстановление снимка заменяет данные: записи после него будут потеряны. До такого шага сохраните также текущую базу.

## Наши порталы: автоматический выпуск из main

`beta.lensws.be` обновляется из `beta` после тестов. После проверки владелец разрешает релиз, проверенный SHA переносится в `main`, CI заново выполняет тесты и последовательно обновляет `do.lensws.be` и `enki.lensws.be`. У каждого своя база, backup и healthcheck. При сбое текущий экземпляр откатывается, workflow завершается ошибкой. [Подробности и настройка GitHub Actions](https://github.com/lensws/opendoist/wiki/Deployment).
