const {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  handleOptions,
  parsePositiveInt,
  parseType,
  searchCatalog,
  sendError,
  setApiHeaders,
} = require('./_catalog');

module.exports = async function handler(req, res) {
  if (handleOptions(req, res)) return;
  setApiHeaders(res);

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Metodo no permitido. Usa GET.' });
    return;
  }

  try {
    const result = await searchCatalog({
      q: req.query.q,
      type: parseType(req.query.type),
      page: parsePositiveInt(req.query.page, 1, 100000),
      limit: parsePositiveInt(req.query.limit, DEFAULT_LIMIT, MAX_LIMIT),
    });
    res.status(200).json(result);
  } catch (error) {
    sendError(res, error);
  }
};
