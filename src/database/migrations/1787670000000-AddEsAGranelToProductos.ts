import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Feature "venta a granel": permite marcar productos que se venden por
 * peso/cantidad fraccionaria (kg, gr, etc.) en vez de por unidad entera, para
 * uso futuro en cálculos de venta por peso/cantidad fraccionaria (cf.
 * `formatCantidad.ts` del frontend). Esta migración solo agrega el campo —
 * la lógica de negocio que lo consuma (validación de cantidades no enteras
 * en tickets, reportes, etc.) es una tarea separada, no incluida acá.
 *
 * `DEFAULT false` sin backfill especial: mismo criterio que
 * AddActivoToProductos1786850000000 y AddAceptoTerminosToUsuarios1787664464018
 * — proyecto en desarrollo, sin datos de producción que preservar.
 */
export class AddEsAGranelToProductos1787670000000 implements MigrationInterface {
  name = 'AddEsAGranelToProductos1787670000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "productos" ADD COLUMN "es_a_granel" boolean NOT NULL DEFAULT false;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "productos" DROP COLUMN IF EXISTS "es_a_granel";
    `);
  }
}
