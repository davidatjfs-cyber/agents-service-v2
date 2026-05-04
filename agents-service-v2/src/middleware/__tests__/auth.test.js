import { jest } from '@jest/globals';

const mockVerify = jest.fn();
jest.unstable_mockModule('jsonwebtoken', () => ({ default: { verify: mockVerify } }));

const { authRequired, requireRole } = await import('../auth.js');

describe('authRequired', () => {
  let req, res, next;

  beforeEach(() => {
    mockVerify.mockReset();
    req = { headers: {} };
    res = { status: jest.fn(() => res), json: jest.fn() };
    next = jest.fn();
  });

  test('missing token returns 401', () => {
    authRequired(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'No token' });
    expect(next).not.toHaveBeenCalled();
  });

  test('Bearer token decoded successfully', () => {
    mockVerify.mockReturnValue({ userId: 1, role: 'admin' });
    req.headers.authorization = 'Bearer valid-token';

    authRequired(req, res, next);
    expect(mockVerify).toHaveBeenCalledWith('valid-token', process.env.JWT_SECRET);
    expect(req.user).toEqual({ userId: 1, role: 'admin' });
    expect(next).toHaveBeenCalled();
  });

  test('invalid token returns 401', () => {
    mockVerify.mockImplementation(() => { throw new Error('jwt malformed'); });
    req.headers.authorization = 'Bearer bad-token';

    authRequired(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid token' });
    expect(next).not.toHaveBeenCalled();
  });
});

describe('requireRole', () => {
  let req, res, next;

  beforeEach(() => {
    req = { user: { role: 'store_manager' } };
    res = { status: jest.fn(() => res), json: jest.fn() };
    next = jest.fn();
  });

  test('allowed role calls next', () => {
    const mw = requireRole('store_manager', 'admin');
    mw(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('disallowed role returns 403', () => {
    const mw = requireRole('admin');
    mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Forbidden' });
    expect(next).not.toHaveBeenCalled();
  });

  test('no user returns 403', () => {
    req.user = undefined;
    const mw = requireRole('admin');
    mw(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });
});
