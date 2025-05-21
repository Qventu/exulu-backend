export const sanitizeName = (name: string) => {
    return name.toLowerCase().replace(/ /g, '_');
}