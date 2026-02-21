# Используем актуальную LTS версию Node.js на базе легковесного Alpine Linux
FROM node:20-alpine
ENV NODE_OPTIONS="--max-old-space-size=256"
# Устанавливаем рабочую директорию внутри контейнера
WORKDIR /usr/src/app
# Сначала копируем только файлы манифестов (package.json и package-lock.json, если есть)
COPY package*.json ./
# Устанавливаем зависимости для продакшена (без devDependencies)
# Совет: когда в проекте зафиксируется package-lock.json, надежнее использовать RUN npm ci --omit=dev
RUN npm install --omit=dev
# Копируем остальной исходный код бота (скрипты, логику)
COPY . .
# Указываем команду для запуска
CMD ["npm", "start"]