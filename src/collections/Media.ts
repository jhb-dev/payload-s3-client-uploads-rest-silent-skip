import type { CollectionConfig } from 'payload'

export const Media: CollectionConfig = {
  slug: 'media',
  access: {
    read: () => true,
  },
  fields: [
    {
      name: 'alt',
      type: 'text',
    },
  ],
  upload: {
    mimeTypes: ['image/*', 'application/pdf'],
    imageSizes: [
      { name: 'xs', width: 480 },
      { name: 'sm', width: 768 },
      { name: 'md', width: 1024 },
      { name: 'lg', width: 1920 },
      { name: 'xl', width: 2560 },
      { name: 'og', width: 1200, height: 630 },
    ],
  },
}
