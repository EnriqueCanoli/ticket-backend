import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { LoginDto } from './login.dto';
import { RegisterDto } from './register.dto';

/**
 * LoginDto y RegisterDto no tenían spec propio (a diferencia de
 * ForgotPasswordDto/ResetPasswordDto en `recovery-dtos.spec.ts`). Este spec
 * cubre específicamente la normalización de `email` (BE-04: trim + minúsculas
 * vía `@Transform`), para tener paridad de cobertura en los 4 endpoints que
 * reciben email.
 */
async function emailErrorsFor<T extends object>(
  cls: new () => T,
  plain: object,
): Promise<string[]> {
  const errors = await validate(plainToInstance(cls, plain));
  const emailError = errors.find((e) => e.property === 'email');
  return emailError ? Object.values(emailError.constraints ?? {}) : [];
}

const VALID_LOGIN_REST = {
  password: 'clave1',
};

const VALID_REGISTER_REST = {
  password: 'clave1',
  phone: '1234567890',
  aceptoTerminos: true,
};

describe('LoginDto: normalización de email (BE-04)', () => {
  it('no da error de validación con espacios y tabulador al borde', async () => {
    const errors = await emailErrorsFor(LoginDto, {
      email: ' user@example.com \t',
      ...VALID_LOGIN_REST,
    });
    expect(errors).toEqual([]);
  });

  it('normaliza el email a trim + minúsculas', () => {
    const dto = plainToInstance(LoginDto, {
      email: '  QA+X@Example.com \t',
      ...VALID_LOGIN_REST,
    });
    expect(dto.email).toBe('qa+x@example.com');
  });

  it('sigue rechazando un email realmente inválido, con el mismo mensaje que antes', async () => {
    const errors = await emailErrorsFor(LoginDto, {
      email: 'no-es-un-email',
      ...VALID_LOGIN_REST,
    });
    expect(errors).toEqual(['email must be an email']);
  });
});

describe('RegisterDto: normalización de email (BE-04)', () => {
  it('no da error de validación con espacios y tabulador al borde', async () => {
    const errors = await emailErrorsFor(RegisterDto, {
      email: ' user@example.com \t',
      ...VALID_REGISTER_REST,
    });
    expect(errors).toEqual([]);
  });

  it('normaliza el email a trim + minúsculas', () => {
    const dto = plainToInstance(RegisterDto, {
      email: '  QA+X@Example.com \t',
      ...VALID_REGISTER_REST,
    });
    expect(dto.email).toBe('qa+x@example.com');
  });

  it('sigue rechazando un email realmente inválido, con el mismo mensaje que antes', async () => {
    const errors = await emailErrorsFor(RegisterDto, {
      email: 'no-es-un-email',
      ...VALID_REGISTER_REST,
    });
    expect(errors).toEqual(['email must be an email']);
  });
});
