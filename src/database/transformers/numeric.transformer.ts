import { ValueTransformer } from 'typeorm';

/**
 * TypeORM devuelve las columnas `numeric`/`decimal` de Postgres como `string`
 * por defecto (para no perder precisión al pasar por JS `number`). Como en
 * este dominio los montos y cantidades se usan en cálculos aritméticos
 * (sumas de subtotales, comparaciones, etc.) y no representan cantidades de
 * dinero de precisión arbitraria en el propio código de la app, se
 * transforman a `number` al leer. Postgres sigue siendo la fuente de verdad
 * de la precisión exacta (columna `numeric(p,s)`); este transformer solo
 * afecta la representación en memoria del lado de Node.
 */
export const numericTransformer: ValueTransformer = {
  to: (value?: number | null) => value,
  from: (value?: string | null) => (value === null || value === undefined ? value : parseFloat(value)),
};
