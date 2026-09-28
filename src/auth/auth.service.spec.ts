import * as bcrypt from 'bcryptjs';
import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AuthService } from './auth.service';
import { Usuario } from '../usuarios/entities/usuario.entity';
import { RefreshToken } from './entities/refresh-token.entity';
import { PasswordResetToken } from './entities/password-reset-token.entity';
import type { Repository } from 'typeorm';

/**
 * Specs unitarios de AuthService, sin base de datos: los repositorios se
 * mockean y el service se construye directamente, igual que en
 * reportes.service.spec.ts. Cubren regeneratePin(), resetPassword() y el
 * claim `tv` que issueTokenPair() firma en el access token.
 */

const PASSWORD = 'password1';
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4);

function buildUsuario(overrides: Partial<Usuario> = {}): Usuario {
  return {
    id: 'user-1',
    email: 'user@example.com',
    passwordHash: PASSWORD_HASH,
    phone: '5512345678',
    pin: '0000',
    aceptoTerminos: true,
    tokenVersion: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    tickets: [],
    productos: [],
    refreshTokens: [],
    ...overrides,
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

interface Manager {
  findOne: jest.Mock;
  save: jest.Mock;
  update: jest.Mock;
  delete: jest.Mock;
  create: jest.Mock;
  transaction: jest.Mock;
}

interface Mocks {
  usuarioRepository: {
    findOne: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
    create: jest.Mock;
    manager: Manager;
  };
  refreshTokenRepository: { create: jest.Mock; save: jest.Mock };
  passwordResetTokenRepository: { manager: Manager };
  manager: Manager;
  jwtService: { signAsync: jest.Mock };
  mailService: { sendPasswordResetCode: jest.Mock };
}

function buildService(): { service: AuthService; mocks: Mocks } {
  // Un único objeto `manager`, compartido por ambos repositorios — igual que
  // en TypeORM real, donde `repository.manager` es la misma instancia de
  // `EntityManager` para todos los repositorios de un mismo DataSource.
  // `forgotPassword()` abre la transacción desde `usuarioRepository.manager`
  // y `resetPassword()` desde `passwordResetTokenRepository.manager`, pero
  // ambas deben resolver al mismo mock para que `transaction()` ejecute el
  // callback contra el mismo `manager` que las aserciones inspeccionan.
  const manager: Manager = {
    findOne: jest.fn(),
    save: jest
      .fn()
      .mockImplementation((entity: unknown) => Promise.resolve(entity)),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    delete: jest.fn().mockResolvedValue({ affected: 0 }),
    create: jest
      .fn()
      .mockImplementation((_entity: unknown, data: unknown) => data),
    transaction: jest
      .fn()
      .mockImplementation((cb: (m: Manager) => Promise<unknown>) =>
        cb(manager),
      ),
  };
  const mocks: Mocks = {
    usuarioRepository: {
      findOne: jest.fn(),
      save: jest.fn().mockImplementation((u: Usuario) => Promise.resolve(u)),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      create: jest.fn().mockImplementation((data: Partial<Usuario>) => ({
        ...data,
      })),
      manager,
    },
    refreshTokenRepository: {
      create: jest.fn().mockImplementation((data: Partial<RefreshToken>) => ({
        id: 'rt-1',
        ...data,
      })),
      save: jest
        .fn()
        .mockImplementation((t: RefreshToken) => Promise.resolve(t)),
    },
    passwordResetTokenRepository: {
      manager,
    },
    manager,
    jwtService: { signAsync: jest.fn().mockResolvedValue('signed-jwt') },
    mailService: {
      sendPasswordResetCode: jest.fn().mockResolvedValue(undefined),
    },
  };

  const configService = {
    get: jest.fn((_key: string, defaultValue: string) => defaultValue),
  };

  const service = new AuthService(
    mocks.usuarioRepository as unknown as Repository<Usuario>,
    mocks.refreshTokenRepository as unknown as Repository<RefreshToken>,
    mocks.passwordResetTokenRepository as unknown as Repository<PasswordResetToken>,
    mocks.jwtService as never,
    configService as never,
    mocks.mailService as never,
  );

  return { service, mocks };
}

describe('AuthService.regeneratePin', () => {
  let service: AuthService;
  let mocks: Mocks;
  let usuario: Usuario;

  beforeEach(() => {
    ({ service, mocks } = buildService());
    usuario = buildUsuario();
  });

  it('con contraseña correcta hace un update parcial condicionado a password_hash y devuelve { pin }', async () => {
    const result = await service.regeneratePin(usuario, {
      password: PASSWORD,
    });

    expect(result.pin).toMatch(/^\d{4}$/);
    expect(mocks.usuarioRepository.update).toHaveBeenCalledTimes(1);
    expect(mocks.usuarioRepository.update).toHaveBeenCalledWith(
      { id: usuario.id, passwordHash: PASSWORD_HASH },
      { pin: result.pin },
    );
    expect(mocks.usuarioRepository.save).not.toHaveBeenCalled();
  });

  it('con contraseña incorrecta lanza 400 "Contraseña incorrecta" y no escribe nada', async () => {
    const originalPin = usuario.pin;

    await expect(
      service.regeneratePin(usuario, { password: 'contraseña-incorrecta1' }),
    ).rejects.toThrow(new BadRequestException('Contraseña incorrecta'));

    expect(usuario.pin).toBe(originalPin);
    expect(mocks.usuarioRepository.update).not.toHaveBeenCalled();
    expect(mocks.usuarioRepository.save).not.toHaveBeenCalled();
  });

  it('si un reset concurrente cambió password_hash (affected: 0) responde 400 "Contraseña incorrecta"', async () => {
    mocks.usuarioRepository.update.mockResolvedValue({ affected: 0 });
    const originalPin = usuario.pin;

    await expect(
      service.regeneratePin(usuario, { password: PASSWORD }),
    ).rejects.toThrow(new BadRequestException('Contraseña incorrecta'));

    expect(usuario.pin).toBe(originalPin);
    expect(mocks.usuarioRepository.save).not.toHaveBeenCalled();
  });
});

describe('AuthService.forgotPassword', () => {
  const FORGOT_PASSWORD_MESSAGE =
    'Si el correo está registrado, recibirás un código para restablecer tu contraseña.';
  let service: AuthService;
  let mocks: Mocks;
  let usuario: Usuario;

  beforeEach(() => {
    ({ service, mocks } = buildService());
    usuario = buildUsuario();
  });

  it('con email existente abre una transacción con lock sobre el usuario (BE-03), borra el token previo, crea uno nuevo y envía el código', async () => {
    mocks.usuarioRepository.findOne.mockResolvedValue(usuario);

    const result = await service.forgotPassword({
      email: '  USER@example.com ',
    });

    expect(result).toEqual({ message: FORGOT_PASSWORD_MESSAGE });

    // La transacción se abre (BE-03: sin esto, dos llamadas concurrentes
    // podían dejar 2+ filas vigentes).
    expect(mocks.manager.transaction).toHaveBeenCalledTimes(1);

    // Lock pessimistic_write sobre la fila de `usuarios`, no sobre la del
    // token (que puede no existir todavía).
    expect(mocks.manager.findOne).toHaveBeenCalledWith(Usuario, {
      where: { id: usuario.id },
      lock: { mode: 'pessimistic_write' },
    });

    expect(mocks.manager.delete).toHaveBeenCalledWith(PasswordResetToken, {
      usuarioId: usuario.id,
    });

    expect(mocks.manager.create).toHaveBeenCalledWith(
      PasswordResetToken,
      expect.objectContaining({ usuarioId: usuario.id }),
    );
    expect(mocks.manager.save).toHaveBeenCalledTimes(1);

    // Email normalizado, código de 6 dígitos en claro (no el hash) enviado
    // fuera de la transacción.
    expect(mocks.mailService.sendPasswordResetCode).toHaveBeenCalledWith(
      'user@example.com',
      expect.stringMatching(/^\d{6}$/),
    );
  });

  it('con email inexistente no abre transacción ni envía correo, y devuelve el mismo mensaje genérico (anti-enumeración)', async () => {
    mocks.usuarioRepository.findOne.mockResolvedValue(null);

    const result = await service.forgotPassword({
      email: 'nadie@example.com',
    });

    expect(result).toEqual({ message: FORGOT_PASSWORD_MESSAGE });
    expect(mocks.manager.transaction).not.toHaveBeenCalled();
    expect(mocks.mailService.sendPasswordResetCode).not.toHaveBeenCalled();
  });

  it('si el envío del correo falla, no lo propaga (fire-and-forget) y la respuesta sigue siendo exitosa', async () => {
    mocks.usuarioRepository.findOne.mockResolvedValue(usuario);
    mocks.mailService.sendPasswordResetCode.mockRejectedValue(
      new Error('Brevo caído'),
    );

    await expect(
      service.forgotPassword({ email: usuario.email }),
    ).resolves.toEqual({ message: FORGOT_PASSWORD_MESSAGE });
  });
});

describe('AuthService.resetPassword', () => {
  const CODE = '123456';
  const NEW_PASSWORD = 'nueva-clave9';
  let service: AuthService;
  let mocks: Mocks;
  let usuario: Usuario;
  let token: PasswordResetToken;

  beforeEach(() => {
    ({ service, mocks } = buildService());
    usuario = buildUsuario();
    mocks.usuarioRepository.findOne.mockResolvedValue(usuario);
    token = {
      id: 'prt-1',
      usuarioId: usuario.id,
      codeHash: sha256(CODE),
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      usedAt: null,
      attempts: 0,
    } as unknown as PasswordResetToken;
    mocks.manager.findOne.mockResolvedValue(token);
  });

  const dto = (code = CODE) => ({
    email: '  USER@example.com ',
    code,
    password: NEW_PASSWORD,
  });

  it('en éxito actualiza password_hash e incrementa token_version en SQL, marca usedAt y revoca los refresh tokens', async () => {
    await expect(service.resetPassword(dto())).resolves.toBeUndefined();

    expect(mocks.usuarioRepository.findOne).toHaveBeenCalledWith({
      where: { email: 'user@example.com' },
    });

    const updateCalls = mocks.manager.update.mock.calls as Array<
      [unknown, Record<string, unknown>, Record<string, unknown>]
    >;
    const usuarioUpdate = updateCalls.find(([entity]) => entity === Usuario);
    expect(usuarioUpdate).toBeDefined();
    const [, criteria, values] = usuarioUpdate as [
      unknown,
      unknown,
      { passwordHash: string; tokenVersion: () => string },
    ];
    expect(criteria).toEqual({ id: usuario.id });
    expect(Object.keys(values).sort()).toEqual(
      ['passwordHash', 'tokenVersion'].sort(),
    );
    expect(await bcrypt.compare(NEW_PASSWORD, values.passwordHash)).toBe(true);
    expect(typeof values.tokenVersion).toBe('function');
    expect(values.tokenVersion()).toBe('"token_version" + 1');

    const refreshUpdate = updateCalls.find(
      ([entity]) => entity === RefreshToken,
    );
    expect(refreshUpdate).toBeDefined();
    const [, refreshCriteria, refreshValues] = refreshUpdate!;
    expect(refreshCriteria.usuarioId).toBe(usuario.id);
    expect(Object.keys(refreshValues)).toEqual(['revokedAt']);
    expect(refreshValues.revokedAt).toBeInstanceOf(Date);

    expect(token.usedAt).toBeInstanceOf(Date);
    expect(mocks.manager.save).toHaveBeenCalledWith(token);
    // Nunca se guarda la entidad Usuario completa (podría revertir el pin).
    expect(mocks.manager.save).not.toHaveBeenCalledWith(usuario);
    expect(mocks.usuarioRepository.save).not.toHaveBeenCalled();
    // El objeto en memoria no se toca: el incremento es solo en SQL.
    expect(usuario.passwordHash).toBe(PASSWORD_HASH);
    expect(usuario.tokenVersion).toBe(0);
  });

  it('con código incorrecto incrementa attempts, no toca al usuario y lanza 400', async () => {
    await expect(service.resetPassword(dto('000000'))).rejects.toThrow(
      new BadRequestException('El código es inválido o expiró'),
    );

    expect(token.attempts).toBe(1);
    expect(mocks.manager.save).toHaveBeenCalledWith(token);
    expect(mocks.manager.update).not.toHaveBeenCalled();
    expect(token.usedAt).toBeNull();
  });

  it('con el token expirado lanza 400 sin escribir', async () => {
    token.expiresAt = new Date(Date.now() - 1000);

    await expect(service.resetPassword(dto())).rejects.toThrow(
      new BadRequestException('El código es inválido o expiró'),
    );
    expect(mocks.manager.save).not.toHaveBeenCalled();
    expect(mocks.manager.update).not.toHaveBeenCalled();
  });

  it('con los intentos agotados lanza 400 sin escribir, aunque el código sea correcto', async () => {
    token.attempts = 5;

    await expect(service.resetPassword(dto())).rejects.toThrow(
      new BadRequestException('El código es inválido o expiró'),
    );
    expect(token.attempts).toBe(5);
    expect(mocks.manager.save).not.toHaveBeenCalled();
    expect(mocks.manager.update).not.toHaveBeenCalled();
  });

  it('sin token vigente lanza 400', async () => {
    mocks.manager.findOne.mockResolvedValue(null);

    await expect(service.resetPassword(dto())).rejects.toThrow(
      new BadRequestException('El código es inválido o expiró'),
    );
    expect(mocks.manager.update).not.toHaveBeenCalled();
  });

  it('con usuario inexistente lanza 400 sin abrir la transacción', async () => {
    mocks.usuarioRepository.findOne.mockResolvedValue(null);

    await expect(service.resetPassword(dto())).rejects.toThrow(
      new BadRequestException('El código es inválido o expiró'),
    );
    expect(
      mocks.passwordResetTokenRepository.manager.transaction,
    ).not.toHaveBeenCalled();
  });
});

describe('AuthService: claim `tv` en el access token (issueTokenPair)', () => {
  let service: AuthService;
  let mocks: Mocks;

  beforeEach(() => {
    ({ service, mocks } = buildService());
  });

  it('login firma el payload con tv = usuario.tokenVersion', async () => {
    const usuario = buildUsuario({ tokenVersion: 3 });
    mocks.usuarioRepository.findOne.mockResolvedValue(usuario);

    const result = await service.login({
      email: 'user@example.com',
      password: PASSWORD,
    });

    expect(mocks.jwtService.signAsync).toHaveBeenCalledWith(
      { sub: usuario.id, email: usuario.email, tv: 3 },
      expect.any(Object),
    );
    expect(result.access_token).toBe('signed-jwt');
    expect(result).not.toHaveProperty('refreshTokenEntity');
  });

  it('register crea el usuario con tokenVersion 0 y firma tv: 0', async () => {
    mocks.usuarioRepository.findOne.mockResolvedValue(null);
    mocks.usuarioRepository.save.mockImplementation((u: Usuario) => {
      u.id = 'nuevo-id';
      return Promise.resolve(u);
    });

    await service.register({
      email: 'Nuevo@Example.com',
      password: PASSWORD,
      phone: '5512345678',
      aceptoTerminos: true,
    });

    expect(mocks.usuarioRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ tokenVersion: 0 }),
    );
    expect(mocks.jwtService.signAsync).toHaveBeenCalledWith(
      { sub: 'nuevo-id', email: 'nuevo@example.com', tv: 0 },
      expect.any(Object),
    );
  });
});
