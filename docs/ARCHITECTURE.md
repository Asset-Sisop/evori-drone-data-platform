# Архитектура

React/Vite отвечает за UI и GIS. FastAPI предоставляет REST API и авторизацию JWT. Файлы сохраняются в volume evori_storage; метаданные проектов, файлов и измерений — в SQLite для автономного MVP.

## Поток

1. Browser → POST /api/auth/login.
2. Browser → Projects API.
3. Browser → multipart upload → Files API.
4. Вариант В автоматизации: /api/import/result прикрепляет готовый обработанный результат к выбранному проекту.
5. Leaflet предоставляет базовую карту и инструменты измерения.
6. GeoJSON отображается как Leaflet GeoJSON layer.
7. GeoTIFF загружается авторизованным запросом, декодируется в браузере через GeoTIFF.js и отображается как Leaflet ImageOverlay. Для координат поддержаны EPSG:4326, EPSG:3857 и UTM EPSG:326xx/327xx.
8. Измерения отправляются в Measurements API.
9. Report endpoint формирует печатный HTML.

## Компоненты

- Frontend: React, Vite, React Leaflet, Leaflet Draw, GeoTIFF.js, proj4js.
- Backend: FastAPI, JWT, SQLite.
- Storage: локальный filesystem volume.
- GIS base map: OpenStreetMap.

## Production evolution

Для production рекомендуется заменить SQLite на PostgreSQL/PostGIS, файловое хранилище на S3-compatible object storage и вынести тяжёлые GIS/photogrammetry jobs в очередь. Дополнительно потребуются audit logging, backups, upload limits, reverse proxy, observability и secrets management.
