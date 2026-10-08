# Архитектура

React/Vite отвечает за UI и GIS. FastAPI предоставляет REST API и авторизацию JWT. Файлы сохраняются в volume `evori_storage`; метаданные проектов, файлов и измерений — в SQLite для автономного MVP.

### Поток
1. Browser → POST `/api/auth/login`.
2. Browser → Projects API.
3. Browser → multipart upload → Files API.
4. Вариант В автоматизации: `/api/import/result` прикрепляет готовый обработанный результат к выбранному проекту.
5. Leaflet предоставляет карту и инструменты измерения.
6. Измерения отправляются в Measurements API.
7. Report endpoint формирует печатный HTML.

### Развитие
Для production рекомендуется заменить SQLite на PostgreSQL/PostGIS, файловое хранилище на S3-compatible object storage и вынести тяжёлые GIS/photogrammetry jobs в очередь.