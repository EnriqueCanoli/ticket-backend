import { BadRequestException } from '@nestjs/common';
import { ReportesController } from './reportes.controller';
import { ReportesService } from './reportes.service';
import type { Usuario } from '../usuarios/entities/usuario.entity';

describe('ReportesController', () => {
  let controller: ReportesController;
  let service: {
    getDia: jest.Mock;
    getMes: jest.Mock;
  };
  const usuario = { id: 'usuario-1' } as Usuario;

  beforeEach(() => {
    service = {
      getDia: jest.fn().mockResolvedValue([]),
      getMes: jest.fn().mockResolvedValue([]),
    };
    controller = new ReportesController(service as unknown as ReportesService);
  });

  describe('getDia', () => {
    it('pasa tz al service cuando viene y es una zona IANA válida', async () => {
      await controller.getDia('America/Cancun', usuario);

      expect(service.getDia).toHaveBeenCalledWith(
        'usuario-1',
        'America/Cancun',
      );
    });

    it('pasa undefined al service cuando tz no viene (deja el fallback al service)', async () => {
      await controller.getDia(undefined, usuario);

      expect(service.getDia).toHaveBeenCalledWith('usuario-1', undefined);
    });

    it('responde 400 sin tocar el service cuando tz no es una zona IANA válida', () => {
      // getDia() no es `async`: la validación lanza de forma síncrona antes
      // de devolver ninguna promesa, así que se prueba con toThrow(), no con
      // `.rejects`.
      expect(() => controller.getDia('Foo/Bar', usuario)).toThrow(
        BadRequestException,
      );
      expect(service.getDia).not.toHaveBeenCalled();
    });

    it('el mensaje del 400 es un string simple, consistente con el resto del módulo', () => {
      try {
        void controller.getDia('Foo/Bar', usuario);
        fail('debía lanzar BadRequestException');
      } catch (error) {
        expect(error).toBeInstanceOf(BadRequestException);
        expect((error as BadRequestException).getResponse()).toMatchObject({
          message: 'tz must be a valid IANA time zone',
        });
      }
    });

    it('acepta zonas IANA con guion bajo (ej. America/Mexico_City)', async () => {
      await controller.getDia('America/Mexico_City', usuario);

      expect(service.getDia).toHaveBeenCalledWith(
        'usuario-1',
        'America/Mexico_City',
      );
    });
  });

  describe('getMes', () => {
    it('pasa mes/anio/tz al service cuando todos vienen y son válidos', async () => {
      await controller.getMes(7, 2026, 'America/Cancun', usuario);

      expect(service.getMes).toHaveBeenCalledWith(
        'usuario-1',
        7,
        2026,
        'America/Cancun',
      );
    });

    it('pasa undefined de tz al service cuando no viene', async () => {
      await controller.getMes(7, undefined, undefined, usuario);

      expect(service.getMes).toHaveBeenCalledWith(
        'usuario-1',
        7,
        undefined,
        undefined,
      );
    });

    it('responde 400 por tz inválido sin tocar el service, incluso con mes/anio válidos', () => {
      expect(() => controller.getMes(7, 2026, 'Foo/Bar', usuario)).toThrow(
        BadRequestException,
      );
      expect(service.getMes).not.toHaveBeenCalled();
    });

    it('sigue validando el rango de mes antes que tz (orden de validación no rompe el 400 de mes)', () => {
      expect(() =>
        controller.getMes(13, undefined, 'Foo/Bar', usuario),
      ).toThrow('mes must be between 1 and 12');
      expect(service.getMes).not.toHaveBeenCalled();
    });
  });
});
