export const sanitizeName = (name: string) => {
  return name.toLowerCase().replace(/ /g, "_")?.trim();
};
