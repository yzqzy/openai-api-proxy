const express = require('express');
const fetch = require('cross-fetch');
const multer = require('multer');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();

const forms = multer({ limits: { fieldSize: 10 * 1024 * 1024 } });

app.use(forms.array());
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

const controller = new AbortController();

app.all(`*`, async (req, res) => {
  if (req.originalUrl) req.url = req.originalUrl;
  let url = `https://api.openai.com${req.url}`;

  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(403).send('Forbidden');

  const openai_key = process.env.OPENAI_KEY || token.split(':')[0];
  if (!openai_key) return res.status(403).send('Forbidden');

  if (openai_key.startsWith('fk'))
    url = url.replaceAll('api.openai.com', 'openai.api2d.net');

  const proxy_key = token.split(':')[1] || '';
  if (process.env.PROXY_KEY && proxy_key !== process.env.PROXY_KEY)
    return res.status(403).send('Forbidden');

  const options = {
    method: req.method,
    timeout: process.env.TIMEOUT || 120 * 1000,
    signal: controller.signal,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: 'Bearer ' + openai_key
    }
  };

  if (req.method.toLocaleLowerCase() === 'post' && req.body)
    options.body = JSON.stringify(req.body);

  try {
    // 如果是 chat completion 和 text completion，使用 SSE
    if (
      (req.url.startsWith('/v1/completions') ||
        req.url.startsWith('/v1/chat/completions')) &&
      req.body.stream
    ) {
      console.log('使用 SSE');
      const response = await $fetch(url, options);
      if (response.ok) {
        // write header
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        });
        const { createParser } = await import('eventsource-parser');
        const parser = createParser(event => {
          if (event.type === 'event') {
            options.onMessage(event.data);
          }
        });
        if (!response.body.getReader) {
          const body = response.body;
          if (!body.on || !body.read) {
            throw new error('unsupported "fetch" implementation');
          }
          body.on('readable', () => {
            let chunk;
            while (null !== (chunk = body.read())) {
              parser.feed(chunk.toString());
            }
          });
        } else {
          for await (const chunk of streamAsyncIterable(response.body)) {
            const str = new TextDecoder().decode(chunk);
            parser.feed(str);
          }
        }
      } else {
        const body = await response.text();
        res.status(response.status).send(body);
      }
    } else {
      console.log('使用 fetch');
      const response = await $fetch(url, options);
      const data = await response.json();
      res.json(data);
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.toString() });
  }
});

async function* streamAsyncIterable(stream) {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

async function $fetch(url, options) {
  const { timeout, ...fetchOptions } = options;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout || 120 * 1000);
  const res = await fetch(url, { ...fetchOptions, signal: controller.signal });
  clearTimeout(timeoutId);
  return res;
}

// Error handler
app.use(function (err, req, res, next) {
  console.error(err);
  res.status(500).send('Internal Serverless Error');
});

const port = process.env.PORT || 9000;
app.listen(port, () => {
  console.log(`Server start on http://localhost:${port}`);
});
