# Оптимизация для слабого VPS

## Применённые изменения

### 1. HTTP соединения (forum_donation_scraper_cheerio.js:22-35)
- `maxSockets: 2` - максимум 2 одновременных HTTP соединения
- `maxFreeSockets: 1` - не держим много свободных сокетов
- `timeout: 60000` - таймаут для неактивных соединений (60 сек)
- `keepAliveMsecs: 30000` - интервал keep-alive

### 2. Telegram polling (telegram_bot.js:22-29)
- `interval: 2000` - проверка каждые 2 секунды (вместо 300ms)
- `timeout: 10` - long polling timeout для экономии запросов

### 3. Управление памятью (forum_donation_scraper_cheerio.js:150-188)
- Лимит кэша: 5MB
- Автоматическое освобождение кэша при превышении лимита
- Вызов `global.gc()` каждые 5 страниц (если включен флаг --expose-gc)
- Очистка Cheerio объектов после парсинга

### 4. Graceful shutdown (telegram_bot.js:117-152)
- Корректная остановка по SIGINT/SIGTERM
- Автоочистка временных файлов при остановке
- Обработка необработанных исключений

## Рекомендуемые команды запуска

### Базовый запуск
```bash
node telegram_bot.js
```

### Оптимизированный запуск для слабого VPS
```bash
node --max-old-space-size=256 --expose-gc telegram_bot.js
```

Параметры:
- `--max-old-space-size=256` - ограничивает heap памяти до 256MB
- `--expose-gc` - позволяет вручную вызывать сборщик мусора

### Запуск с PM2 (рекомендуется)
```bash
npm install -g pm2
pm2 start telegram_bot.js --name donation-bot --max-memory-restart 200M -- --expose-gc
pm2 save
pm2 startup
```

PM2 будет автоматически перезапускать бот при превышении 200MB памяти.

## Дополнительные рекомендации

### 1. Мониторинг памяти
```bash
# Просмотр использования памяти
pm2 monit

# Логи
pm2 logs donation-bot
```

### 2. Настройка swap (если нет)
```bash
sudo fallocate -l 1G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
```

### 3. Автоочистка временных файлов
Добавьте в crontab:
```bash
crontab -e
# Добавьте строку (очистка каждый час):
0 * * * * find /path/to/project/temp -type f -mmin +60 -delete
```

### 4. Уменьшение логирования
Если нужно ещё больше снизить нагрузку, отключите console.log в продакшене:
```javascript
// В начале telegram_bot.js
if (process.env.NODE_ENV === 'production') {
  console.log = () => {};
}
```

### 5. Настройка окружения (.env)
```bash
NODE_ENV=production
TELEGRAM_BOT_TOKEN=your_token_here
```

## Ожидаемое потребление ресурсов

- **CPU**: 5-15% в режиме ожидания, 30-60% при парсинге
- **RAM**: 50-150MB в режиме ожидания, до 200MB при парсинге
- **Network**: ~10-50 KB/s при polling, до 1-2 MB/s при скачивании форума

## Устранение проблем

### Бот использует слишком много памяти
1. Уменьшите `MAX_CACHE_SIZE` в `forum_donation_scraper_cheerio.js:169` (с 5MB до 2MB)
2. Уменьшите `cacheTtl` в конструкторе (с 1800000 до 900000 - 15 минут)

### Бот медленно отвечает
1. Увеличьте `options.delay` (с 500ms до 1000ms) для уменьшения нагрузки
2. Уменьшите `options.timeout` (с 30000 до 15000) если соединение стабильное

### Превышение CPU при парсинге
1. Увеличьте delay между страницами: `options.delay = 1000`
2. Ограничьте количество страниц: `options.maxPages = 50`
