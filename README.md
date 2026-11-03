# OpenDoist

Личный менеджер задач и Markdown-заметок для своего сервера. Распознаёт даты и повторения на русском и английском без LLM и внешних API.

Проекты и дочерние задачи, список/доска/календарь, файлы, поиск, email и Telegram, резервные копии в папку или S3. Данные хранятся в SQLite. Один общий список и один пароль; многопользовательского режима пока нет. Лицензия GPL-3.0.

## Установка на Linux

```bash
curl -fsSL https://raw.githubusercontent.com/lensws/opendoist/main/install/install.sh | sudo bash
```

Мастер спросит домен и пароль, установит Docker на Ubuntu/Debian и настроит HTTPS. По умолчанию устанавливается `main`. [Требования и параметры →](https://github.com/lensws/opendoist/wiki/Installation)

## Обновление

Повторный запуск установщика **не обновляет версию**. [Инструкция →](https://github.com/lensws/opendoist/wiki/Updating): ручное обновление до последнего `main` с резервной копией, ежедневное автообновление через systemd и выпуск через GitHub Actions.

## Документация

Вся подробная документация — в [GitHub Wiki](https://github.com/lensws/opendoist/wiki):

- [Работа с задачами, заметками и поиском](https://github.com/lensws/opendoist/wiki/Usage)
- [Уведомления: email и Telegram](https://github.com/lensws/opendoist/wiki/Notifications)
- [Резервные копии и восстановление](https://github.com/lensws/opendoist/wiki/Backups)
- [Распознавание дат, повторения и API](https://github.com/lensws/opendoist/wiki/Development)
- [Развёртывание и CI/CD](https://github.com/lensws/opendoist/wiki/Deployment)

Для разработки: Node.js 24+, `npm ci`, пароль в `.env` по образцу `.env.example`, `npm start`. Проверки: `npm test`.

Документация также хранится в [docs/wiki](docs/wiki/Home.md). OpenDoist — независимый проект, не связанный с Todoist.
