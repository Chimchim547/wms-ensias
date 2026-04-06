const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

router.get('/', async (req, res) => {
  const inventaires = await prisma.inventaire.findMany({
    include: { lignes: { include: { article: true } } }
  });
  res.render('inventaire/index', { inventaires });
});

router.get('/planifier', (req, res) => res.render('inventaire/planifier'));

router.post('/planifier', async (req, res) => {
  const { datePlanification } = req.body;
  
  const articles = await prisma.article.findMany({
    include: { mouvements: true }
  });
  
  const lignes = articles.map(article => {
    const entrees = article.mouvements.filter(m => m.type === 'ENTREE').reduce((sum, m) => sum + m.quantite, 0);
    const sorties = article.mouvements.filter(m => m.type === 'SORTIE').reduce((sum, m) => sum + m.quantite, 0);
    const stockTheorique = entrees - sorties;
    return {
      articleId: article.id,
      reference: article.reference,
      designation: article.designation,
      quantiteTheorique: stockTheorique
    };
  });
  
  await prisma.inventaire.create({
    data: {
      datePlanification: new Date(datePlanification),
      lignes: { create: lignes }
    }
  });
  
  res.redirect('/inventaire');
});

router.get('/comptage/:id', async (req, res) => {
  const inventaire = await prisma.inventaire.findUnique({
    where: { id: parseInt(req.params.id) },
    include: { lignes: { include: { article: true } } }
  });
  res.render('inventaire/comptage', { inventaire });
});

router.post('/comptage/:id', async (req, res) => {
  const { ligneIds, quantitesReelles, justificatifs } = req.body;
  
  const ids = Array.isArray(ligneIds) ? ligneIds : [ligneIds];
  const qrs = Array.isArray(quantitesReelles) ? quantitesReelles : [quantitesReelles];
  const justs = Array.isArray(justificatifs) ? justificatifs : [justificatifs];
  
  for (let i = 0; i < ids.length; i++) {
    const ligne = await prisma.ligneInventaire.findUnique({ where: { id: parseInt(ids[i]) } });
    const qr = parseInt(qrs[i]);
    const ecart = qr - ligne.quantiteTheorique;
    
    await prisma.ligneInventaire.update({
      where: { id: parseInt(ids[i]) },
      data: {
        quantiteReelle: qr,
        ecart: ecart,
        justificatif: justs[i] || null
      }
    });
  }
  
  res.redirect('/inventaire');
});

router.post('/rapprochement/:id', async (req, res) => {
  const inventaire = await prisma.inventaire.findUnique({
    where: { id: parseInt(req.params.id) },
    include: { lignes: true }
  });
  
  for (const ligne of inventaire.lignes) {
    const ecart = ligne.quantiteReelle - ligne.quantiteTheorique;
    await prisma.ligneInventaire.update({
      where: { id: ligne.id },
      data: { ecart }
    });
  }
  
  res.redirect(`/inventaire/detail/${req.params.id}`);
});

router.post('/valider/:id', async (req, res) => {
  await prisma.inventaire.update({
    where: { id: parseInt(req.params.id) },
    data: { dateRealisation: new Date() }
  });
  res.redirect('/inventaire');
});

router.get('/detail/:id', async (req, res) => {
  const inventaire = await prisma.inventaire.findUnique({
    where: { id: parseInt(req.params.id) },
    include: { lignes: { include: { article: true } } }
  });
  let valeurInventaire = 0;
  inventaire.lignes.forEach(l => {
    valeurInventaire += l.quantiteReelle * l.article.coutMoyenPondere;
  });
  res.render('inventaire/detail', { inventaire, valeurInventaire });
});

module.exports = router;