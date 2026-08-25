import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Feature "Aceptación obligatoria de Términos y Condiciones / Política de
 * Privacidad en el registro": se persiste un booleano simple, sin versionar
 * el texto legal ni guardar fecha de aceptación (decisión de producto — no
 * hace falta más que saber si el usuario aceptó o no).
 *
 * `DEFAULT false` sin backfill especial: mismo criterio que
 * AddActivoToProductos1786850000000 y AddUniquePhoneToUsuarios1786880000000
 * — proyecto en desarrollo, sin datos de producción que preservar. Las filas
 * ya existentes quedan en `false` (no aceptaron el texto nuevo, que es la
 * realidad), no se les asigna `true` artificialmente.
 */
export class AddAceptoTerminosToUsuarios1787664464018 implements MigrationInterface {
  name = 'AddAceptoTerminosToUsuarios1787664464018';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "usuarios" ADD COLUMN "acepto_terminos" boolean NOT NULL DEFAULT false;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "usuarios" DROP COLUMN IF EXISTS "acepto_terminos";
    `);
  }
}
