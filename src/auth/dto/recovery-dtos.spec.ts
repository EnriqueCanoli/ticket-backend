import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ForgotPasswordDto } from './forgot-password.dto';
import { ResetPasswordDto } from './reset-password.dto';
import { RegeneratePinDto } from './regenerate-pin.dto';

/**
 * Mensajes de validación en español de los DTOs del flujo de recuperación y
 * de regeneración del PIN. Son parte del contrato con el frontend, por eso se
 * comparan con el texto exacto.
 */
const PASSWORD_FORMAT =
  'La contraseña debe tener al menos 6 caracteres y al menos un número';
const PASSWORD_BYTES =
  'La contraseña no puede pesar más de 72 bytes (los acentos pesan 2, los emojis hasta 4)';
const CODE_FORMAT = 'El código son 6 dígitos';
const EMAIL_FORMAT = 'Ingresa un correo válido';

async function messagesFor<T extends object>(
  cls: new () => T,
  plain: object,
): Promise<Record<string, string[]>> {
  const errors = await validate(plainToInstance(cls, plain));
  return Object.fromEntries(
    errors.map((e) => [e.property, Object.values(e.constraints ?? {})]),
  );
}

describe('DTOs de recuperación de contraseña y PIN: mensajes en español', () => {
  it('ForgotPasswordDto: email inválido', async () => {
    expect(
      await messagesFor(ForgotPasswordDto, { email: 'no-es-correo' }),
    ).toEqual({ email: [EMAIL_FORMAT] });
  });

  it('ResetPasswordDto: email, código y contraseña inválidos', async () => {
    const result = await messagesFor(ResetPasswordDto, {
      email: 'x',
      code: '12a',
      password: 'abc',
    });
    expect(result.email).toEqual([EMAIL_FORMAT]);
    expect(result.code).toEqual([CODE_FORMAT]);
    expect(result.password).toEqual([PASSWORD_FORMAT]);
  });

  it('ResetPasswordDto: contraseña de más de 72 bytes', async () => {
    const result = await messagesFor(ResetPasswordDto, {
      email: 'user@example.com',
      code: '123456',
      password: '1' + 'á'.repeat(40),
    });
    expect(result).toEqual({ password: [PASSWORD_BYTES] });
  });

  it('ResetPasswordDto válido no tiene errores', async () => {
    const result = await messagesFor(ResetPasswordDto, {
      email: 'user@example.com',
      code: '123456',
      password: 'clave1',
    });
    expect(result).toEqual({});
  });

  it('ForgotPasswordDto: email con espacios y tabulador al borde no da error de validación (BE-04)', async () => {
    const result = await messagesFor(ForgotPasswordDto, {
      email: ' user@example.com \t',
    });
    expect(result).toEqual({});
  });

  it('ResetPasswordDto: email con espacios y tabulador al borde no da error de validación (BE-04)', async () => {
    const result = await messagesFor(ResetPasswordDto, {
      email: ' user@example.com \t',
      code: '123456',
      password: 'clave1',
    });
    expect(result).toEqual({});
  });

  it('ForgotPasswordDto: normaliza el email a trim + minúsculas (BE-04)', () => {
    const dto = plainToInstance(ForgotPasswordDto, {
      email: '  QA+X@Example.com \t',
    });
    expect(dto.email).toBe('qa+x@example.com');
  });

  it('ResetPasswordDto: normaliza el email a trim + minúsculas (BE-04)', () => {
    const dto = plainToInstance(ResetPasswordDto, {
      email: '  QA+X@Example.com \t',
      code: '123456',
      password: 'clave1',
    });
    expect(dto.email).toBe('qa+x@example.com');
  });

  it('RegeneratePinDto: formato y bytes de la contraseña', async () => {
    expect(
      await messagesFor(RegeneratePinDto, { password: 'sinnumero' }),
    ).toEqual({ password: [PASSWORD_FORMAT] });
    expect(
      await messagesFor(RegeneratePinDto, { password: '1' + '😀'.repeat(18) }),
    ).toEqual({ password: [PASSWORD_BYTES] });
  });
});
