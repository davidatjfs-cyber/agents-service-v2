import {
  markOllamaFail,
  markOllamaOk,
  isOllamaHealthy,
  getOllamaHealthStatus
} from '../model-router.js';

describe('Ollama health state management', () => {
  test('starts healthy', () => {
    expect(isOllamaHealthy()).toBe(true);
  });

  test('getOllamaHealthStatus returns current state', () => {
    const status = getOllamaHealthStatus();
    expect(status).toHaveProperty('healthy');
    expect(status).toHaveProperty('failCount');
    expect(status).toHaveProperty('model');
    expect(typeof status.model).toBe('string');
  });

  test('markOllamaFail increments counter without error for first call', () => {
    const before = getOllamaHealthStatus().failCount;
    markOllamaFail();
    expect(getOllamaHealthStatus().failCount).toBe(before + 1);
  });

  test('markOllamaOk resets state', () => {
    // Ensure we start with a clean state by calling markOllamaOk first
    markOllamaOk();
    const status = getOllamaHealthStatus();
    expect(status.failCount).toBe(0);
    expect(status.healthy).toBe(true);
  });
});
