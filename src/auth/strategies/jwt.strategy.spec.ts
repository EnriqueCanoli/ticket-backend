import { UnauthorizedException } from '@nestjs/common';
import { JwtStrategy } from './jwt.strategy';
import { AuthService } from '../auth.service';
import { Usuario } from '../../usuarios/entities/usuario.entity';
import type { Repository } from 'typeorm';

/**
 * JwtStrategy.validate() con un AuthService real (la comparación del claim
 * `tv` vive en AuthService.validateAccessTokenPayload) sobre un repositorio
 * de usuarios falso, y un ConfigService falso que solo entrega el secreto.
 */
describe('JwtStrategy.validate', () => {
  let strategy: JwtStrategy;
  let findOne: jest.Mock;

  const usuarioConVersion = (tokenVersion: number) =>
    ({ id: 'user-1', email: 'user@example.com', tokenVersion }) as Usuario;

  beforeEach(() => {
    findOne = jest.fn();
    const configService = {
      get: jest.fn((_key: string, defaultValue: string) => defaultValue),
      getOrThrow: jest.fn().mockReturnValue('secreto-de-test'),
    };
    const authService = new AuthService(
      { findOne } as unknown as Repository<Usuario>,
      {} as never,
      {} as never,
      {} as never,
      configService as never,
      {} as never,
    );
    strategy = new JwtStrategy(configService as never, authService);
  });

  const payload = (tv?: number) => ({
    sub: 'user-1',
    email: 'user@example.com',
    ...(tv === undefined ? {} : { tv }),
  });

  it('tv igual a tokenVersion: devuelve el usuario', async () => {
    const usuario = usuarioConVersion(2);
    findOne.mockResolvedValue(usuario);

    await expect(strategy.validate(payload(2))).resolves.toBe(usuario);
    expect(findOne).toHaveBeenCalledWith({ where: { id: 'user-1' } });
  });

  it('tv menor que tokenVersion (token previo a un reset): 401', async () => {
    findOne.mockResolvedValue(usuarioConVersion(2));

    await expect(strategy.validate(payload(1))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('sin tv (token previo al despliegue) y tokenVersion 0: pasa', async () => {
    const usuario = usuarioConVersion(0);
    findOne.mockResolvedValue(usuario);

    await expect(strategy.validate(payload())).resolves.toBe(usuario);
  });

  it('sin tv y tokenVersion > 0: 401', async () => {
    findOne.mockResolvedValue(usuarioConVersion(1));

    await expect(strategy.validate(payload())).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('usuario inexistente: 401', async () => {
    findOne.mockResolvedValue(null);

    await expect(strategy.validate(payload(0))).rejects.toThrow(
      UnauthorizedException,
    );
  });
});
