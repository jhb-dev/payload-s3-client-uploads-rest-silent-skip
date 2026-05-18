import type { CollectionConfig } from 'payload'

const ApiKeys: CollectionConfig = {
  slug: 'api-keys',
  auth: {
    useAPIKey: true,
    disableLocalStrategy: true,
  },
  access: {
    read: () => true,
    create: () => true,
    update: () => true,
    delete: () => true,
  },
  fields: [
    {
      name: 'type',
      type: 'select',
      required: true,
      options: [
        { label: 'Website', value: 'website' },
        { label: 'Agent', value: 'agent' },
      ],
    },
  ],
}

export default ApiKeys
