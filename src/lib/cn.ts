import clsx, { type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Spajanje klasa; kasnija Tailwind klasa pobjeđuje raniju (npr. boja teksta iz `className`). */
export const cn = (...v: ClassValue[]) => twMerge(clsx(v));
