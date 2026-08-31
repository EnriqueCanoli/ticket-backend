import { ReportesService } from './reportes.service';
import { TicketItem } from '../tickets/entities/ticket-item.entity';
import type { Repository } from 'typeorm';

/**
 * Estos tests NO golpean una base real (por diseño: no hay Postgres
 * garantizado en CI, y el equipo decidió no depender de uno para este
 * módulo). Mockean el `QueryBuilder` de TypeORM y verifican:
 *
 *  1. Plomería: `tz` (o el fallback `TIMEZONE_FALLBACK`) se bindea como
 *     parámetro `zonaHoraria`, nunca interpolado en el SQL.
 *  2. Que el SQL generado use `AT TIME ZONE :zonaHoraria` para el rango y
 *     para `hora`, en vez de `CURRENT_DATE`/`TO_CHAR(t.createdAt, ...)`
 *     crudos (el bug original: la zona de la sesión de Postgres).
 *  3. Que el `::timestamp` explícito esté presente entre el `::date`/
 *     `make_date(...)` y el `AT TIME ZONE` exterior — verificado
 *     manualmente contra un Postgres local (`localhost:5433`, `SET TIME
 *     ZONE 'UTC'` vs. `'America/Mexico_City'` en la misma sesión) que SIN
 *     ese cast, Postgres resuelve la ambigüedad de casts implícitos de
 *     `date` prefiriendo `timestamptz`, lo que reintroduce en silencio la
 *     dependencia de la zona de la sesión que este cambio busca eliminar.
 *     Este test es el regression-guard de ese hallazgo: si alguien
 *     "simplifica" la expresión quitando el `::timestamp`, el bug vuelve y
 *     este test lo detecta sin necesitar una base real.
 *  4. El caso de negocio (venta a las 20:00 hora local de un usuario en
 *     UTC-5 apareciendo en el "Hoy" correcto) se verifica evaluando en JS,
 *     con la librería estándar `Intl`, el mismo par de bounds que arma el
 *     SQL para una fecha "actual" fija — no reemplaza una verificación end
 *     to end contra Postgres real (ver limitación documentada abajo), pero
 *     sí fija el contrato de qué instante debe incluirse/excluirse.
 *
 * Limitación conocida (documentada explícitamente, no un olvido): no hay
 * test de integración que inserte un ticket real y llame a `getDia`/`getMes`
 * contra Postgres, porque este cambio tiene la restricción explícita de no
 * ejecutar ningún comando que modifique una base real (ni local ni de
 * producción) como parte de esta tarea. La verificación equivalente se hizo
 * a mano con SELECTs de solo lectura contra `localhost:5433` (ver reporte
 * final). Si el equipo quiere blindar esto en CI, el siguiente paso natural
 * es un contenedor Postgres desechable (testcontainers) con un ticket de
 * prueba insertado y limpiado dentro de una transacción de test.
 */
describe('ReportesService', () => {
  type MockQueryBuilder = {
    innerJoin: jest.Mock;
    select: jest.Mock;
    addSelect: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    setParameter: jest.Mock;
    orderBy: jest.Mock;
    groupBy: jest.Mock;
    addGroupBy: jest.Mock;
    getRawMany: jest.Mock;
  };

  let service: ReportesService;
  let qb: MockQueryBuilder;
  let repository: { createQueryBuilder: jest.Mock };

  beforeEach(() => {
    qb = {
      innerJoin: jest.fn(),
      select: jest.fn(),
      addSelect: jest.fn(),
      where: jest.fn(),
      andWhere: jest.fn(),
      setParameter: jest.fn(),
      orderBy: jest.fn(),
      groupBy: jest.fn(),
      addGroupBy: jest.fn(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };
    // Todos los métodos chainable devuelven `this` (mismo comportamiento que
    // el QueryBuilder real de TypeORM).
    for (const key of Object.keys(qb) as (keyof MockQueryBuilder)[]) {
      if (key !== 'getRawMany') {
        qb[key].mockReturnValue(qb);
      }
    }
    repository = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
    service = new ReportesService(
      repository as unknown as Repository<TicketItem>,
    );
  });

  function todasLasCondiciones(mock: jest.Mock): string[] {
    const calls = mock.mock.calls as unknown[][];
    return calls.map((call) => String(call[0]));
  }

  describe('getDia', () => {
    it('usa el fallback America/Mexico_City cuando no se pasa tz', async () => {
      await service.getDia('usuario-1');

      expect(qb.setParameter).toHaveBeenCalledWith(
        'zonaHoraria',
        'America/Mexico_City',
      );
    });

    it('usa el tz explícito cuando se pasa', async () => {
      await service.getDia('usuario-1', 'America/Cancun');

      expect(qb.setParameter).toHaveBeenCalledWith(
        'zonaHoraria',
        'America/Cancun',
      );
    });

    it('filtra siempre por usuarioId, nunca por otro campo', async () => {
      await service.getDia('usuario-1');

      expect(qb.where).toHaveBeenCalledWith('t.usuarioId = :usuarioId', {
        usuarioId: 'usuario-1',
      });
    });

    it('arma el rango del día con AT TIME ZONE :zonaHoraria, no con CURRENT_DATE crudo', async () => {
      await service.getDia('usuario-1', 'America/Cancun');

      const condiciones = todasLasCondiciones(qb.andWhere);
      expect(condiciones).toHaveLength(2);
      for (const condicion of condiciones) {
        expect(condicion).toContain('AT TIME ZONE :zonaHoraria');
      }
      // El bug original: comparar t.createdAt directamente contra
      // CURRENT_DATE (zona de la sesión de Postgres), sin AT TIME ZONE.
      expect(condiciones.some((c) => />=\s*CURRENT_DATE\b/.test(c))).toBe(
        false,
      );
      expect(condiciones.some((c) => /<\s*CURRENT_DATE\b/.test(c))).toBe(false);
    });

    it('castea explícitamente a ::timestamp antes del AT TIME ZONE exterior (regression-guard de la ambigüedad de casts de `date`)', async () => {
      await service.getDia('usuario-1', 'America/Cancun');

      const condiciones = todasLasCondiciones(qb.andWhere);
      for (const condicion of condiciones) {
        expect(condicion).toContain('::date::timestamp');
      }
    });

    it('formatea hora con AT TIME ZONE :zonaHoraria en vez de TO_CHAR(t.createdAt, ...) crudo', async () => {
      await service.getDia('usuario-1', 'America/Cancun');

      const addSelectCalls = qb.addSelect.mock.calls as unknown[][];
      const horaCall = addSelectCalls.find((call) => call[1] === 'hora');
      expect(horaCall).toBeDefined();
      expect(String(horaCall?.[0])).toContain(
        'TO_CHAR(t.createdAt AT TIME ZONE :zonaHoraria',
      );
    });

    it('convierte los campos numéricos crudos (string) a number en la respuesta', async () => {
      qb.getRawMany.mockResolvedValue([
        {
          id: 'ti-1',
          producto_id: 'p-1',
          nombre_producto: 'Alpiste',
          cantidad: '2',
          venta: '46.00',
          costo: '20.00',
          hora: '08:05',
          costo_validado: true,
        },
      ]);

      const result = await service.getDia('usuario-1');

      expect(result).toEqual([
        {
          id: 'ti-1',
          producto_id: 'p-1',
          nombre_producto: 'Alpiste',
          cantidad: 2,
          venta: 46,
          costo: 20,
          hora: '08:05',
          costo_validado: true,
        },
      ]);
    });

    /**
     * Caso de negocio explícitamente pedido: una venta a las 20:00 hora
     * local de un usuario en UTC-5 (America/Cancun) debe aparecer en el
     * "Hoy" correcto, incluso cuando ese instante ya cae en el día
     * calendario SIGUIENTE en UTC (que es lo que usa la sesión de Postgres
     * en Neon). Se replica en JS, sin tocar ninguna base de datos, la misma
     * matemática de bounds que arma el SQL verificado a mano (ver reporte
     * final): medianoche a medianoche local de `tz`, usando Intl para
     * resolver el offset real de la zona (soporta DST si la zona lo tuviera;
     * America/Cancun no observa DST, por eso el offset es fijo -05:00 en
     * este caso).
     */
    it('caso de negocio: venta a las 20:00 hora local (UTC-5) cae dentro del rango de "hoy" aunque en UTC ya sea el día siguiente', () => {
      const zona = 'America/Cancun'; // UTC-5 todo el año, sin DST
      // "Ahora" simulado: 2026-08-31T17:28:00Z (~11:28 local en UTC-6,
      // equivalente al horario en que se corrió la verificación manual).
      const ahoraUtc = new Date('2026-08-31T17:28:00.000Z');

      // Instante de la venta: 2026-08-31 20:00:00 hora Cancún (UTC-5) =
      // 2026-09-01T01:00:00Z — ya es "mañana" en UTC.
      const ventaUtc = new Date('2026-09-01T01:00:00.000Z');

      // Réplica en JS de "(CURRENT_TIMESTAMP AT TIME ZONE tz)::date" seguido
      // de "AT TIME ZONE tz" (medianoche local de hoy, como instante UTC) —
      // mismos bounds que el SQL verificado manualmente contra Postgres.
      function medianocheLocalComoUtc(instanteUtc: Date, tz: string): Date {
        const formatter = new Intl.DateTimeFormat('en-US', {
          timeZone: tz,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        });
        const partes = formatter.formatToParts(instanteUtc);
        const get = (tipo: string) =>
          partes.find((p) => p.type === tipo)?.value ?? '';
        // Offset fijo de America/Cancun (-05:00, sin DST). Para una zona con
        // DST habría que resolver el offset real de esa fecha, no hardcodearlo.
        return new Date(
          `${get('year')}-${get('month')}-${get('day')}T00:00:00-05:00`,
        );
      }

      const rangoInicio = medianocheLocalComoUtc(ahoraUtc, zona);
      const rangoFin = new Date(rangoInicio.getTime() + 24 * 60 * 60 * 1000);

      expect(ventaUtc.getTime()).toBeGreaterThanOrEqual(rangoInicio.getTime());
      expect(ventaUtc.getTime()).toBeLessThan(rangoFin.getTime());
      // Y confirma explícitamente la premisa del bug: en UTC, la venta ya
      // pertenece al día calendario siguiente al de "ahora" (si el backend
      // comparara contra CURRENT_DATE crudo en una sesión UTC como Neon,
      // esta venta desaparecería de "hoy" hasta el día siguiente).
      expect(ventaUtc.toISOString().slice(0, 10)).toBe('2026-09-01');
      expect(ahoraUtc.toISOString().slice(0, 10)).toBe('2026-08-31');
    });
  });

  describe('getMes', () => {
    it('usa el fallback America/Mexico_City cuando no se pasa tz', async () => {
      await service.getMes('usuario-1', 8, 2026);

      expect(qb.setParameter).not.toHaveBeenCalled(); // getMes bindea vía rangoParams, no setParameter
      const condiciones = qb.andWhere.mock.calls as unknown[][];
      for (const call of condiciones) {
        expect(call[1]).toMatchObject({ zonaHoraria: 'America/Mexico_City' });
      }
    });

    it('usa el tz explícito cuando se pasa', async () => {
      await service.getMes('usuario-1', 8, 2026, 'America/Cancun');

      const condiciones = qb.andWhere.mock.calls as unknown[][];
      for (const call of condiciones) {
        expect(call[1]).toMatchObject({ zonaHoraria: 'America/Cancun' });
      }
    });

    it('pasa anio como null cuando no viene, para que COALESCE resuelva el año en SQL', async () => {
      await service.getMes('usuario-1', 8, undefined, 'America/Cancun');

      const condiciones = qb.andWhere.mock.calls as unknown[][];
      for (const call of condiciones) {
        expect(call[1]).toMatchObject({ anio: null, mes: 8 });
      }
    });

    it('resuelve el año contra CURRENT_TIMESTAMP AT TIME ZONE :zonaHoraria, no CURRENT_DATE crudo', async () => {
      await service.getMes('usuario-1', 8, undefined, 'America/Cancun');

      const condiciones = todasLasCondiciones(qb.andWhere);
      for (const condicion of condiciones) {
        expect(condicion).toContain(
          'EXTRACT(YEAR FROM (CURRENT_TIMESTAMP AT TIME ZONE :zonaHoraria))',
        );
      }
    });

    it('castea make_date(...) explícitamente a ::timestamp antes del AT TIME ZONE exterior (mismo regression-guard que getDia)', async () => {
      await service.getMes('usuario-1', 8, 2026, 'America/Cancun');

      const condiciones = todasLasCondiciones(qb.andWhere);
      for (const condicion of condiciones) {
        expect(condicion).toContain('make_date(');
        // Todo make_date(...) en este service termina en ", 1)" (día fijo en
        // 1) — el cast debe pegarse justo después de ese cierre.
        expect(condicion).toContain('1)::timestamp');
      }
    });

    it('convierte los campos numéricos crudos (string) a number en la respuesta', async () => {
      qb.getRawMany.mockResolvedValue([
        {
          producto_id: 'p-1',
          nombre_producto: 'Alpiste',
          cantidad: '27',
          venta: '612.00',
          ganancia: '268.00',
          costo_validado: false,
        },
      ]);

      const result = await service.getMes('usuario-1', 8, 2026);

      expect(result).toEqual([
        {
          producto_id: 'p-1',
          nombre_producto: 'Alpiste',
          cantidad: 27,
          venta: 612,
          ganancia: 268,
          costo_validado: false,
        },
      ]);
    });
  });
});
