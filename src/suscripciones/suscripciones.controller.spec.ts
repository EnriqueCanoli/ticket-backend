import { SuscripcionesController } from './suscripciones.controller';
import type { SuscripcionesService } from './suscripciones.service';
import type { Usuario } from '../usuarios/entities/usuario.entity';

describe('SuscripcionesController', () => {
  it('obtener delega en snapshot(usuario) y devuelve su resultado', async () => {
    const snapshot = { estado: 'prueba', historial: [] };
    const service = { snapshot: jest.fn().mockResolvedValue(snapshot) };
    const controller = new SuscripcionesController(
      service as unknown as SuscripcionesService,
    );
    const usuario = { id: 'user-1' } as Usuario;

    await expect(controller.obtener(usuario)).resolves.toBe(snapshot);
    expect(service.snapshot).toHaveBeenCalledWith(usuario);
  });
});
