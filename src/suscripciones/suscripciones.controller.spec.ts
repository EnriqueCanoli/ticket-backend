import { SuscripcionesController } from './suscripciones.controller';
import type { SuscripcionesService } from './suscripciones.service';
import type { CompraSuscripcionService } from './compra-suscripcion.service';
import type { ValidarCompraDto } from './dto/validar-compra.dto';
import type { RestaurarComprasDto } from './dto/restaurar-compras.dto';
import type { Usuario } from '../usuarios/entities/usuario.entity';

describe('SuscripcionesController', () => {
  const snapshot = { estado: 'prueba', historial: [] };
  const usuario = { id: 'user-1' } as Usuario;

  function build() {
    const service = { snapshot: jest.fn().mockResolvedValue(snapshot) };
    const compras = {
      validarCompra: jest.fn().mockResolvedValue(snapshot),
      restaurarCompras: jest.fn().mockResolvedValue(snapshot),
    };
    const controller = new SuscripcionesController(
      service as unknown as SuscripcionesService,
      compras as unknown as CompraSuscripcionService,
    );
    return { controller, service, compras };
  }

  it('obtener delega en snapshot(usuario) y devuelve su resultado', async () => {
    const { controller, service } = build();

    await expect(controller.obtener(usuario)).resolves.toBe(snapshot);
    expect(service.snapshot).toHaveBeenCalledWith(usuario);
  });

  it('validarCompra delega en CompraSuscripcionService.validarCompra', async () => {
    const { controller, compras } = build();
    const dto = {
      tienda: 'google_play',
      producto_id: 'PENDIENTE',
      token_compra: 'mock-compra-1',
    } as ValidarCompraDto;

    await expect(controller.validarCompra(dto, usuario)).resolves.toBe(
      snapshot,
    );
    expect(compras.validarCompra).toHaveBeenCalledWith(usuario, dto);
  });

  it('restaurarCompras delega en CompraSuscripcionService.restaurarCompras', async () => {
    const { controller, compras } = build();
    const dto = { tienda: 'google_play', compras: [] } as RestaurarComprasDto;

    await expect(controller.restaurarCompras(dto, usuario)).resolves.toBe(
      snapshot,
    );
    expect(compras.restaurarCompras).toHaveBeenCalledWith(usuario, dto);
  });
});
