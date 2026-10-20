import { assertSafeProviderUrl } from './url-guard';

const bad = (u: string, kind = 'openai') => () => assertSafeProviderUrl(u, kind);

describe('provider URL guard (SSRF)', () => {
  it('accepts public https endpoints and an unset URL', () => {
    expect(bad('https://api.openai.com/v1')).not.toThrow();
    expect(bad('https://my-resource.openai.azure.com')).not.toThrow();
    expect(() => assertSafeProviderUrl(null, 'anthropic')).not.toThrow();
  });
  it.each([
    'http://api.example.com',
    'https://localhost/v1',
    'https://127.0.0.1/v1',
    'https://[::1]/v1',
    'https://10.0.0.5',
    'https://192.168.1.10',
    'https://172.20.0.2',
    'https://169.254.169.254/latest/meta-data',
    'https://metadata.google.internal',
    'https://db.internal',
    'https://printer.local',
    'https://intranet',
    'https://100.64.0.1',
    'https://[::ffff:10.0.0.1]',
    'https://[fd00::1]',
    'https://[fe80::1]',
    'https://0.0.0.0',
    'https://2130706433', // decimal form of 127.0.0.1: the URL parser normalizes it, so it is caught
    'https://0x7f.1',
    'https://user:pass@api.example.com',
    'ftp://api.example.com',
    'not a url',
  ])('rejects %s', (u) => {
    expect(bad(u)).toThrow();
  });
  it('lets a local model server (Ollama) use a private address but never the metadata range', () => {
    expect(bad('http://localhost:11434', 'ollama')).not.toThrow();
    expect(bad('http://10.0.0.7:11434', 'ollama')).not.toThrow();
    expect(bad('http://169.254.169.254', 'ollama')).toThrow();
    expect(bad('ftp://host', 'ollama')).toThrow();
  });
});
