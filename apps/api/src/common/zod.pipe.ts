import { BadRequestException, PipeTransform } from '@nestjs/common';
import { ZodTypeAny, z } from 'zod';

export class ZodPipe<T extends ZodTypeAny> implements PipeTransform {
  constructor(private readonly schema: T) {}
  transform(value: unknown): z.infer<T> {
    const r = this.schema.safeParse(value);
    if (!r.success) {
      throw new BadRequestException(r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`));
    }
    return r.data;
  }
}
