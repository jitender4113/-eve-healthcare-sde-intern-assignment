const { api } = require('./helpers');

// No database needed: these exercise the shared error handling only.

test('a body over the size limit is a 413, not a 500', async () => {
  const res = await api()
    .post('/auth/login')
    .set('Content-Type', 'application/json')
    .send(JSON.stringify({ email: 'a@example.com', password: 'x'.repeat(200_000) }));
  expect(res.status).toBe(413);
  expect(res.body).toEqual({ detail: 'Request body too large' });
});

test('every error response has a string `detail`', async () => {
  const responses = await Promise.all([
    api().get('/nope'), // 404
    api().get('/bookings/'), // 401
    api().get('/centres/abc'), // 422
    api().post('/auth/login').set('Content-Type', 'application/json').send('{"email":'), // 400
  ]);
  expect(responses.map((r) => r.status)).toEqual([404, 401, 422, 400]);
  for (const res of responses) expect(typeof res.body.detail).toBe('string');
});
