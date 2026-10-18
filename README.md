# DeepFlix — plugin de Kino

Películas y series en **español latino**, a través del addon de Stremio de DeepFlix (`mg.homelabx.qzz.io`), con el catálogo de
TMDB. Necesita Kino 0.9.55 o posterior.

Es la misma fuente que el plugin **Latino** trae entre las suyas (`src/sources/deepflix.js` allá); este plugin va solo, sin las
demás fuentes ni sus ajustes.

## Instalar

En Kino: **Plugins ▸ Agregar un plugin ▸ Kino**, y pega la dirección de este repositorio.

## Qué trae

- **Inicio** con catorce filas de TMDB (populares, en cines, próximos estrenos, mejor valoradas, series en emisión y películas
  por género). Cada título lleva sus géneros, así el Inicio de Kino lo archiva en la fila de cada género.
- **Búsqueda** y **categorías** por TMDB.
- **Reproducción directa:** DeepFlix responde con un enlace que redirige al archivo de video; Kino lo reproduce tal cual. Si el
  addon da más de un enlace, el primero se reproduce y los demás quedan como copias.
- Textos en español e inglés.

## Notas

- DeepFlix solo ofrece latino y suele traer una sola copia por título, en 720p.
- El archivo llega por **http** desde un servidor propio del addon, por eso el manifest pide `streamHosts: "any"` (Kino lo muestra
  en rojo al instalar).
- Que haya o no un título depende del addon, no del plugin.

## Desarrollo

```
node --test test/plugin.test.mjs    # sin red: un DeepFlix simulado
node sdk/validate.mjs .             # el manifest, como lo revisa Kino
```

`sdk/` y `contract.json` son el kit de pruebas abierto de Kino (Apache-2.0). Usa este plugin con contenido que tengas derecho a ver.
