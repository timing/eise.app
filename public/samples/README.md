# Sample files

Files served from `/samples/` for the "Try a sample Jupiter clip" button on the homepage.

## Current

- `jupiter-sample.mp4` — Jupiter capture used by the homepage "try a sample" button.

## Deploying a new sample

1. Drop the file at `public/samples/jupiter-sample.mp4` (or update `SAMPLE_URL` / `SAMPLE_NAME` / `SAMPLE_MIME` in `components/FileUploader.vue`).
2. Commit and push — Cloudflare Pages picks up the file automatically.
3. Verify at `https://eise.app/samples/jupiter-sample.mp4` after deploy.

## Size limit

Cloudflare Pages caps individual files at 25 MiB (~26.2 MB). If a sample gets close, either:
- Trim frames or lower bitrate with ffmpeg, or
- Host on Cloudflare R2 / another CDN and set `SAMPLE_URL` to the absolute URL.

The button gracefully shows an error if the fetch returns non-OK.
