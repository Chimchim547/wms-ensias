const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

router.get('/', async (req, res) => {
  const emplacements = await prisma.emplacement.findMany({
    include: { zone: { include: { categorie: true } }, articles: true, stockEmplacements: { include: { article: true } } }
  });
  res.render('emplacements/index', { emplacements });
});

router.get('/create', async (req, res) => {
  const zones = await prisma.zone.findMany();
  res.render('emplacements/create', { zones });
});

router.post('/create', async (req, res) => {
  const { code, longueur, largeur, hauteur, poidsMax, zoneId } = req.body;
  await prisma.emplacement.create({
    data: {
      code,
      longueur: parseFloat(longueur), largeur: parseFloat(largeur),
      hauteur: parseFloat(hauteur), poidsMax: parseFloat(poidsMax),
      zoneId: parseInt(zoneId)
    }
  });
  res.redirect('/emplacements');
});

router.post('/delete/:id', async (req, res) => {
  await prisma.emplacement.delete({ where: { id: parseInt(req.params.id) } });
  res.redirect('/emplacements');
});

router.get('/affecter', async (req, res) => {
  const articlesAll = await prisma.article.findMany({
    include: { mouvements: true, categorie: true, emplacement: { include: { zone: true } } }
  });
  
  // Charger les répartitions existantes
  const toutesRepartitions = await prisma.stockEmplacement.findMany();
  
  const articlesFiltres = articlesAll.filter(a => {
    const entrees = a.mouvements.filter(m => m.type === 'ENTREE').reduce((sum, m) => sum + m.quantite, 0);
    const sorties = a.mouvements.filter(m => m.type === 'SORTIE').reduce((sum, m) => sum + m.quantite, 0);
    a.stockActuel = entrees - sorties;
    
    if (a.stockActuel <= 0) return false;
    
    // Calculer stock déjà réparti
    const repartitions = toutesRepartitions.filter(r => r.articleId === a.id);
    a.stockReparti = repartitions.reduce((sum, r) => sum + r.quantite, 0);
    a.stockAAffecter = a.stockActuel - a.stockReparti;
    
    if (a.emplacement) {
      a.emplacementActuel = a.emplacement.code + ' (' + a.emplacement.zone.code + ')';
    }
    
    return a.stockAAffecter > 0;
  });

  const emplacements = await prisma.emplacement.findMany({
    include: { zone: { include: { categorie: true } }, articles: true, stockEmplacements: { include: { article: true } } }
  });
  
  // Emplacements disponibles = libres OU partiellement remplis (capacité restante)
  const emplacementsDisponibles = emplacements.filter(e => {
    const qteStockee = e.stockEmplacements.reduce((sum, s) => sum + s.quantite, 0);
    e.qteStockee = qteStockee;
    e.capaciteRestante = undefined;
    e.articleStockeId = null;
    
    if (qteStockee === 0) return true; // Totalement libre
    
    // Vérifier s'il reste de la capacité (partiel)
    if (e.stockEmplacements.length > 0) {
      const art = e.stockEmplacements[0].article;
      const volEmp = e.longueur * e.largeur * e.hauteur;
      const volArt = art.longueur * art.largeur * art.hauteur;
      const capVol = volArt > 0 ? Math.floor(volEmp / volArt) : 1;
      const capPoids = art.poids > 0 ? Math.floor(e.poidsMax / art.poids) : capVol;
      const capMax = Math.min(capVol, capPoids);
      e.capaciteRestante = capMax - qteStockee;
      e.articleStockeId = art.id;
      return e.capaciteRestante > 0; // Partiel = encore de la place
    }
    return false;
  });
  
  const articles = articlesFiltres.map(article => {
    const poidsTotal = article.stockAAffecter * article.poids;
    
    const compatibles = emplacementsDisponibles.filter(e => {
      if (e.zone.type !== 'stockage') return false;
      if (e.zone.categorieId && article.categorieId !== e.zone.categorieId) return false;
      if (article.longueur > e.longueur || article.largeur > e.largeur || article.hauteur > e.hauteur) return false;
      if (article.longueur > e.zone.dimensionMaxLongueur || article.largeur > e.zone.dimensionMaxLargeur || article.hauteur > e.zone.dimensionMaxHauteur) return false;
      if (article.poids > e.poidsMax) return false;
      if (article.poids > e.zone.poidsMax) return false;
      // Si l'emplacement contient déjà un AUTRE article, pas compatible
      if (e.articleStockeId && e.articleStockeId !== article.id) return false;
      return true;
    });

    const compatiblesAvecCapacite = compatibles.map(e => {
      const volEmp = e.longueur * e.largeur * e.hauteur;
      const volArt = article.longueur * article.largeur * article.hauteur;
      const capVolume = volArt > 0 ? Math.floor(volEmp / volArt) : 1;
      const capPoids = article.poids > 0 ? Math.floor(e.poidsMax / article.poids) : capVolume;
      let capaciteMax = Math.min(capVolume, capPoids);
      // Si l'emplacement a déjà du stock, utiliser la capacité restante
      if (e.capaciteRestante !== undefined && e.capaciteRestante < capaciteMax) {
        capaciteMax = e.capaciteRestante;
      }
      return { ...e, capaciteMax };
    });

    const capaciteTotale = compatiblesAvecCapacite.reduce((sum, e) => sum + e.capaciteMax, 0);
    const besoinRepartition = article.stockAAffecter > 0 && compatiblesAvecCapacite.length > 0 && !compatiblesAvecCapacite.some(e => e.capaciteMax >= article.stockAAffecter);

    return { 
      ...article, 
      compatibles: compatiblesAvecCapacite, 
      poidsTotal: poidsTotal.toFixed(1),
      capaciteTotale,
      besoinRepartition
    };
  });
  
  res.render('emplacements/affecter', { articles, emplacements: emplacementsDisponibles });
});

router.post('/affecter', async (req, res) => {
  const { articleId, emplacementId } = req.body;
  const article = await prisma.article.findUnique({ 
    where: { id: parseInt(articleId) },
    include: { mouvements: true }
  });
  const emplacement = await prisma.emplacement.findUnique({
    where: { id: parseInt(emplacementId) },
    include: { zone: true, stockEmplacements: true }
  });
  
  const problemes = [];
  if (article.longueur > emplacement.longueur) problemes.push('Emplacement - Longueur: ' + article.longueur + ' > ' + emplacement.longueur + ' cm');
  if (article.largeur > emplacement.largeur) problemes.push('Emplacement - Largeur: ' + article.largeur + ' > ' + emplacement.largeur + ' cm');
  if (article.hauteur > emplacement.hauteur) problemes.push('Emplacement - Hauteur: ' + article.hauteur + ' > ' + emplacement.hauteur + ' cm');
  if (article.poids > emplacement.poidsMax) problemes.push('Emplacement - Poids: ' + article.poids + ' > ' + emplacement.poidsMax + ' kg');
  if (article.longueur > emplacement.zone.dimensionMaxLongueur) problemes.push('Zone - Longueur dépasse');
  if (article.largeur > emplacement.zone.dimensionMaxLargeur) problemes.push('Zone - Largeur dépasse');
  if (article.hauteur > emplacement.zone.dimensionMaxHauteur) problemes.push('Zone - Hauteur dépasse');
  if (article.poids > emplacement.zone.poidsMax) problemes.push('Zone - Poids dépasse');
  
  if (problemes.length > 0) {
    return res.render('emplacements/erreur-affectation', { article, emplacement, problemes });
  }
  
  // Calculer la capacité de cet emplacement
  const volEmp = emplacement.longueur * emplacement.largeur * emplacement.hauteur;
  const volArt = article.longueur * article.largeur * article.hauteur;
  const capVolume = volArt > 0 ? Math.floor(volEmp / volArt) : 1;
  const capPoids = article.poids > 0 ? Math.floor(emplacement.poidsMax / article.poids) : capVolume;
  const capaciteMax = Math.min(capVolume, capPoids);
  
  // Stock déjà dans cet emplacement
  const dejaStockeDansEmp = emplacement.stockEmplacements.reduce((sum, s) => sum + s.quantite, 0);
  const capaciteRestante = capaciteMax - dejaStockeDansEmp;
  
  // Calculer le stock restant à affecter globalement
  const entrees = article.mouvements.filter(m => m.type === 'ENTREE').reduce((sum, m) => sum + m.quantite, 0);
  const sorties = article.mouvements.filter(m => m.type === 'SORTIE').reduce((sum, m) => sum + m.quantite, 0);
  const stockTotal = entrees - sorties;
  
  const stockDejaReparti = await prisma.stockEmplacement.aggregate({
    where: { articleId: parseInt(articleId) },
    _sum: { quantite: true }
  });
  const dejaReparti = stockDejaReparti._sum.quantite || 0;
  const resteAAffecter = stockTotal - dejaReparti;
  
  const quantiteAAffecter = Math.min(capaciteRestante, resteAAffecter);
  
  if (quantiteAAffecter <= 0) {
    return res.render('emplacements/erreur-affectation', {
      article, emplacement,
      problemes: [capaciteRestante <= 0 ? 'Cet emplacement est plein.' : 'Tout le stock est déjà réparti. Rien à affecter.']
    });
  }
  
  // Créer la répartition
  await prisma.stockEmplacement.upsert({
    where: { articleId_emplacementId: { articleId: parseInt(articleId), emplacementId: parseInt(emplacementId) } },
    create: { articleId: parseInt(articleId), emplacementId: parseInt(emplacementId), quantite: quantiteAAffecter },
    update: { quantite: { increment: quantiteAAffecter } }
  });
  
  // Mettre à jour emplacementId (dernier emplacement pour compatibilité)
  await prisma.article.update({
    where: { id: parseInt(articleId) },
    data: { emplacementId: parseInt(emplacementId) }
  });

  const totalRepartiApres = dejaReparti + quantiteAAffecter;
  const resteApres = stockTotal - totalRepartiApres;

  let message = article.reference + ' : ' + quantiteAAffecter + ' unité(s) → ' + emplacement.code + ' (Zone ' + emplacement.zone.code + ').';
  if (resteApres > 0) {
    message += ' Reste ' + resteApres + ' unité(s) à affecter.';
  } else {
    message += ' Tout le stock est réparti.';
  }

  await prisma.notification.create({
    data: { message, lien: '/zones/plan', destinataireRole: 'RESPONSABLE_ENTREPOT' }
  });

  res.redirect('/emplacements/affecter');
});

module.exports = router;