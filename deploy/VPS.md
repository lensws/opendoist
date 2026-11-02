# VPS: основная и тестовая версии

Сервер: `217.60.249.240` / `2a13:7c00:3:7:f816:3eff:feb5:78b3`, Ubuntu 24.04.

| | Основная | Тестовая |
| --- | --- | --- |
| Адрес | https://do.lensws.be | https://beta.lensws.be |
| Каталог на сервере | /opt/opendoist/prod | /opt/opendoist/beta |
| Compose project | opendoist-prod | opendoist-beta |
| Локальный порт | 3000 | 3001 |
| SQLite volume | opendoist-prod_opendoist-data | opendoist-beta_opendoist-data |

Caddy работает на хосте и принимает HTTPS по IPv4/IPv6. Его конфигурация: `/etc/caddy/Caddyfile`, образец — [vps.Caddyfile](vps.Caddyfile). Приложения слушают только loopback. Каждая установка имеет свой `.env` с независимым случайным паролем, `PUBLIC_URL`, `PORT`, `COOKIE_SECURE=true` и фиксированным `COMPOSE_PROJECT_NAME`. Файлы `.env` доступны только root. Секреты не хранятся в Git.

## Установка двух окружений с нуля

**На уже работающем VPS эти шаги повторять не нужно.** Для переноса на чистый сервер сначала установите Docker, Compose, Caddy и Git по [общей инструкции](README.md#0-подготовка-ubuntu-2404). Укажите A/AAAA-записи обоих доменов на новый сервер.

Выполните от root:

```sh
mkdir -p /opt/opendoist
git clone https://github.com/lensws/opendoist.git /opt/opendoist/prod
git clone https://github.com/lensws/opendoist.git /opt/opendoist/beta
release_sha=$(git -C /opt/opendoist/prod rev-parse origin/main)
git -C /opt/opendoist/prod checkout --detach "$release_sha"
git -C /opt/opendoist/beta checkout --detach "$release_sha"
cp /opt/opendoist/prod/.env.example /opt/opendoist/prod/.env
cp /opt/opendoist/beta/.env.example /opt/opendoist/beta/.env
chmod 600 /opt/opendoist/prod/.env /opt/opendoist/beta/.env
```

В редакторе заполните `.env` для каждого окружения. Замените значения паролей на два разных случайных пароля длиной не менее 12 символов.

Основная версия, `/opt/opendoist/prod/.env`:

```dotenv
COMPOSE_PROJECT_NAME=opendoist-prod
OPENDOIST_PASSWORD=change-this-before-use
PUBLIC_URL=https://do.lensws.be
COOKIE_SECURE=true
PORT=3000
```

Тестовая версия, `/opt/opendoist/beta/.env`:

```dotenv
COMPOSE_PROJECT_NAME=opendoist-beta
OPENDOIST_PASSWORD=change-this-before-use
PUBLIC_URL=https://beta.lensws.be
COOKIE_SECURE=true
PORT=3001
```

`COMPOSE_PROJECT_NAME` изолирует контейнеры, сети и тома SQLite. Не меняйте его после создания данных: новое имя подключит другой том, и приложение будет выглядеть пустым.

Соберите окружения последовательно и подключите домены:

```sh
cd /opt/opendoist/prod
docker compose up -d --build
cd /opt/opendoist/beta
docker compose up -d --build
caddy validate --config /opt/opendoist/prod/deploy/vps.Caddyfile --adapter caddyfile
cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.before-opendoist
install -m 644 /opt/opendoist/prod/deploy/vps.Caddyfile /etc/caddy/Caddyfile
systemctl reload caddy
```

Замена Caddyfile рассчитана на чистый сервер. Если на хосте есть другие сайты, добавьте два блока в существующую конфигурацию, затем проверьте и перезагрузите Caddy.

Откройте оба сайта и проверьте вход с соответствующими паролями. Данные основной версии не должны появляться на beta. Проверка без входа:

```sh
curl --fail https://do.lensws.be/healthz
curl --fail https://beta.lensws.be/healthz
```

## Доступ

Подключитесь к серверу своим SSH-ключом:

```sh
ssh root@217.60.249.240
```

Откройте `/opt/opendoist/prod/.env` или `/opt/opendoist/beta/.env` в своём терминальном редакторе. Значение `OPENDOIST_PASSWORD` — пароль для соответствующего сайта. Не отправляйте его в чат и не включайте в логи. При смене пароля пересоздайте только соответствующий экземпляр:

```sh
cd /opt/opendoist/prod
docker compose up -d
```

## Проверка состояния

```sh
cd /opt/opendoist/prod
docker compose ps
cd /opt/opendoist/beta
docker compose ps
systemctl status caddy --no-pager
```

Не используйте `docker compose config` без ограничения вывода: он раскрывает значения окружения, включая пароль.

## Автоматические обновления

Настроен [GitHub Actions pipeline](automation/README.md): push в `beta` после тестов обновляет `beta.lensws.be`, push в `main` — `do.lensws.be`. Оба экземпляра запускают точный SHA проверенного коммита; checkout на VPS остаётся в detached HEAD.

Обычный порядок: изменения в beta → успешные тесты и деплой → владелец проверяет тестовый сайт → пишет агенту «выкатывай на основной» → проверенный коммит переносится в main → повторные тесты и production-деплой. PR и ручное одобрение в GitHub не требуются. Force push и удаление main запрещены; успешные тесты обязательны. Логи — во вкладке Actions. Перед выкладкой автоматически создаётся резервная копия базы.

## Аварийное ручное обновление

Используйте только при недоступности Actions. Сначала убедитесь, что проверки выбранного SHA прошли, и дождитесь завершения текущей выкладки. Не запускайте Compose параллельно автоматическому деплою.

```sh
# Защититесь от одновременного автоматического деплоя.
flock /run/lock/opendoist-deploy.lock bash
cd /opt/opendoist/beta
git fetch origin
# Вместо <commit-sha> подставьте проверенный SHA.
git checkout --detach <commit-sha>
# Перед изменением prod сделайте backup по deploy/README.md.
docker compose up -d --build --wait --wait-timeout 120
exit
```

Для основной версии используйте `/opt/opendoist/prod`. Следующий push в соответствующую ветку снова запустит автоматический деплой.

Не копируйте `.env` и SQLite между окружениями. При откате можно пересобрать предыдущий SHA; если будущая версия меняет схему данных несовместимо, потребуется восстановление совместимой резервной копии.

Перед автоматическим деплоем выполняется backup в `/var/backups/opendoist/{prod,beta}/`. Регулярное резервирование вне деплоев, копирование на другой сервер и мониторинг пока не настроены. VPS имеет около 1 ГБ RAM: сборки окружений лучше запускать последовательно.
