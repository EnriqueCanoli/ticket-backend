import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * El catálogo de `productos` era global (compartido entre todas las cuentas).
 * Corrige el modelo para que sea privado por usuario, mismo patrón que ya usa
 * `tickets.usuario_id` en `InitialSchema1786831831517` (columna + FK + índice).
 *
 * Proyecto en desarrollo, sin datos de producción que preservar: la columna
 * se agrega directamente `NOT NULL`, sin backfill. La base de datos de
 * desarrollo se resetea por separado antes de correr esta migración.
 */
export class AddUsuarioIdToProductos1786840000000 implements MigrationInterface {
  name = 'AddUsuarioIdToProductos1786840000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "productos"
        ADD COLUMN "usuario_id" uuid NOT NULL;
    `);
    await queryRunner.query(`
      ALTER TABLE "productos"
        ADD CONSTRAINT "FK_productos_usuario_id" FOREIGN KEY ("usuario_id")
          REFERENCES "usuarios" ("id");
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_productos_usuario_id" ON "productos" ("usuario_id");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_productos_usuario_id";`);
    await queryRunner.query(`
      ALTER TABLE "productos" DROP CONSTRAINT IF EXISTS "FK_productos_usuario_id";
    `);
    await queryRunner.query(`
      ALTER TABLE "productos" DROP COLUMN IF EXISTS "usuario_id";
    `);
  }
}
