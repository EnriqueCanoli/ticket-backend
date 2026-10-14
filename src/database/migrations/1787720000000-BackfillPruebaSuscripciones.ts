import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migración de DATOS (la estructura la crea CreateSuscripcionesTables): da a
 * toda cuenta existente sin fila en `suscripciones` 14 días de prueba desde
 * el día de la migración, que cuenta como el día 1. `prueba_fin` es el día
 * de la migración + 13 días a las 23:59:59 en `America/Mexico_City`, el mismo
 * cálculo que `finDePrueba()` (src/suscripciones/fechas.ts) usa en los
 * registros nuevos (docs/suscripcion/flujo_suscripcion.md, sección 3.8).
 *
 * El `up` es idempotente (`NOT EXISTS`): se puede repetir sin duplicar filas.
 *
 * Limitación del `down`: borra TODAS las filas con `estado = 'prueba'`, sin
 * poder distinguir las creadas por este backfill de las creadas después por
 * registros nuevos. Aun así es seguro, porque el `down` de
 * CreateSuscripcionesTables (que se revierte justo después) elimina las
 * tablas completas.
 */
export class BackfillPruebaSuscripciones1787720000000 implements MigrationInterface {
  name = 'BackfillPruebaSuscripciones1787720000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO "suscripciones" ("usuario_id", "estado", "prueba_inicio", "prueba_fin", "estado_desde")
      SELECT u."id", 'prueba', now(),
             (date_trunc('day', now() AT TIME ZONE 'America/Mexico_City')
                + interval '14 days' - interval '1 second') AT TIME ZONE 'America/Mexico_City',
             now()
      FROM "usuarios" u
      WHERE NOT EXISTS (SELECT 1 FROM "suscripciones" s WHERE s."usuario_id" = u."id");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "suscripciones" WHERE "estado" = 'prueba';`,
    );
  }
}
