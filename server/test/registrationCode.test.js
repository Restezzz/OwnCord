import {
  describe, it, expect, afterEach, beforeAll,
} from 'vitest';
import request from 'supertest';
import { buildTestApp } from './appFactory.js';

let app;

beforeAll(() => {
  app = buildTestApp();
});

afterEach(() => {
  delete process.env.REGISTRATION_CODE;
  delete process.env.REGISTRATION_DISABLED;
});

describe('registration gating', () => {
  it('exposes registration-info reflecting env vars', async () => {
    let res = await request(app).get('/api/auth/registration-info');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ disabled: false, inviteRequired: false });

    process.env.REGISTRATION_CODE = 'letmein';
    res = await request(app).get('/api/auth/registration-info');
    expect(res.body).toMatchObject({ disabled: false, inviteRequired: true });

    process.env.REGISTRATION_DISABLED = '1';
    res = await request(app).get('/api/auth/registration-info');
    expect(res.body.disabled).toBe(true);
  });

  it('rejects registration when REGISTRATION_DISABLED=1', async () => {
    process.env.REGISTRATION_DISABLED = '1';
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'reg_off_user', password: 'secret123' });
    expect(res.status).toBe(403);
  });

  it('requires invite when REGISTRATION_CODE is set', async () => {
    process.env.REGISTRATION_CODE = 'sesame';
    const a = await request(app)
      .post('/api/auth/register')
      .send({ username: 'inv_user_a', password: 'secret123' });
    expect(a.status).toBe(400);

    const b = await request(app)
      .post('/api/auth/register')
      .send({ username: 'inv_user_b', password: 'secret123', invite: 'wrong' });
    expect(b.status).toBe(403);

    const c = await request(app)
      .post('/api/auth/register')
      .send({ username: 'inv_user_c', password: 'secret123', invite: 'sesame' });
    expect(c.status).toBe(200);
    expect(c.body.token).toBeTruthy();
  });
});
