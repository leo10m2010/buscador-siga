const { getItem, handleOptions, sendError, setApiHeaders } = require('./_catalog');

module.exports = async function handler(req, res) {
  if (handleOptions(req, res)) return;
  setApiHeaders(res);

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Metodo no permitido. Usa GET.' });
    return;
  }

  try {
    const result = await getItem(req.query.codigo);
    res.status(200).json(result);
  } catch (error) {
    sendError(res, error);
  }
};
