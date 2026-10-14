import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { VerificadorPushOidc } from './pubsub-auth';
import type { ClienteIdToken } from './pubsub-auth';

const AUDIENCIA = 'https://api.ejemplo.com/tienda/google/rtdn';
const EMAIL = 'push@proyecto.iam.gserviceaccount.com';

function construir(
  verifyIdToken: jest.Mock,
  audiencia: string | null = AUDIENCIA,
  email: string | null = EMAIL,
) {
  const cliente: ClienteIdToken = {
    verifyIdToken: verifyIdToken as ClienteIdToken['verifyIdToken'],
  };
  return new VerificadorPushOidc(audiencia, email, cliente);
}

const ticket = (payload: Record<string, unknown> | undefined) => ({
  getPayload: () => payload,
});

describe('VerificadorPushOidc', () => {
  it('sin header Authorization: 401 y no llama a la librería', async () => {
    const verify = jest.fn();
    await expect(construir(verify).verificar(undefined)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(verify).not.toHaveBeenCalled();
  });

  it.each(['abc', 'Basic abc', 'Bearer', 'bearer abc', 'Bearer '])(
    'formato inválido (%s): 401',
    async (header) => {
      const verify = jest.fn();
      await expect(construir(verify).verificar(header)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(verify).not.toHaveBeenCalled();
    },
  );

  it('audiencia incorrecta (la librería lanza): 401', async () => {
    const verify = jest
      .fn()
      .mockRejectedValue(
        new Error('Wrong recipient, payload audience != requiredAudience'),
      );
    await expect(construir(verify).verificar('Bearer jwt')).rejects.toThrow(
      UnauthorizedException,
    );
    expect(verify).toHaveBeenCalledWith({
      idToken: 'jwt',
      audience: AUDIENCIA,
    });
  });

  it('firma inválida o vencido: 401', async () => {
    const verify = jest
      .fn()
      .mockRejectedValue(new Error('Invalid token signature'));
    await expect(construir(verify).verificar('Bearer jwt')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('correo distinto: 401', async () => {
    const verify = jest
      .fn()
      .mockResolvedValue(ticket({ email: 'otro@x.com', email_verified: true }));
    await expect(construir(verify).verificar('Bearer jwt')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('email_verified falso o ausente: 401', async () => {
    for (const payload of [
      { email: EMAIL, email_verified: false },
      { email: EMAIL },
    ]) {
      const verify = jest.fn().mockResolvedValue(ticket(payload));
      await expect(construir(verify).verificar('Bearer jwt')).rejects.toThrow(
        UnauthorizedException,
      );
    }
  });

  it('sin payload: 401', async () => {
    const verify = jest.fn().mockResolvedValue(ticket(undefined));
    await expect(construir(verify).verificar('Bearer jwt')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('certificados de Google caídos: 503', async () => {
    for (const error of [
      new Error('Failed to retrieve verification certificates: boom'),
      Object.assign(new Error('x'), { code: 'ENOTFOUND' }),
      Object.assign(new Error('x'), { response: { status: 503 } }),
    ]) {
      const verify = jest.fn().mockRejectedValue(error);
      await expect(construir(verify).verificar('Bearer jwt')).rejects.toThrow(
        ServiceUnavailableException,
      );
    }
  });

  it('token válido: resuelve', async () => {
    const verify = jest
      .fn()
      .mockResolvedValue(ticket({ email: EMAIL, email_verified: true }));
    await expect(
      construir(verify).verificar('Bearer jwt'),
    ).resolves.toBeUndefined();
  });

  it('sin audiencia o sin correo configurados: rechaza todo con 401', async () => {
    const verify = jest
      .fn()
      .mockResolvedValue(ticket({ email: EMAIL, email_verified: true }));
    await expect(
      construir(verify, null, EMAIL).verificar('Bearer jwt'),
    ).rejects.toThrow(UnauthorizedException);
    await expect(
      construir(verify, AUDIENCIA, null).verificar('Bearer jwt'),
    ).rejects.toThrow(UnauthorizedException);
    expect(verify).not.toHaveBeenCalled();
  });
});
