import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { MENSAJE_SUSCRIPCION_REQUERIDA } from '../bloqueo';
import type { SuscripcionesService } from '../suscripciones.service';
import { SuscripcionActivaGuard } from './suscripcion-activa.guard';

function buildContext(user?: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

function buildGuard() {
  const assertPuedeEscribir = jest.fn();
  const guard = new SuscripcionActivaGuard({
    assertPuedeEscribir,
  } as unknown as SuscripcionesService);
  return { guard, assertPuedeEscribir };
}

describe('SuscripcionActivaGuard', () => {
  const user = { id: 'user-1', createdAt: new Date('2026-03-03T09:12:00Z') };

  it('llama a assertPuedeEscribir con request.user y retorna true si no está bloqueada', async () => {
    const { guard, assertPuedeEscribir } = buildGuard();
    assertPuedeEscribir.mockResolvedValue(undefined);

    await expect(guard.canActivate(buildContext(user))).resolves.toBe(true);
    expect(assertPuedeEscribir).toHaveBeenCalledWith(user);
  });

  it('propaga el 403 con el mensaje exacto', async () => {
    const { guard, assertPuedeEscribir } = buildGuard();
    assertPuedeEscribir.mockRejectedValue(
      new ForbiddenException(MENSAJE_SUSCRIPCION_REQUERIDA),
    );

    const error = await guard
      .canActivate(buildContext(user))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).message).toBe(
      MENSAJE_SUSCRIPCION_REQUERIDA,
    );
  });

  it('lanza 401 si no hay user y no consulta la suscripción', async () => {
    const { guard, assertPuedeEscribir } = buildGuard();

    await expect(guard.canActivate(buildContext(undefined))).rejects.toThrow(
      UnauthorizedException,
    );
    expect(assertPuedeEscribir).not.toHaveBeenCalled();
  });
});
